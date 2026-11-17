import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { hashPassword, sessionTokenHash } from "../src/auth.js";

const admin = { id: 1, username: "admin", display_name: "Admin", role: "admin", active: true };
const technician = { id: 2, username: "tech", display_name: "Tech", role: "technician", active: true };
const adminHash = hashPassword("correct-horse-battery");

function fakePool() {
  return {
    query: async (sql, params = []) => {
      const text = String(sql);
      if (text.includes("FROM sessions s")) {
        if (params[0] === sessionTokenHash("admin-session-token-abcdef")) return { rows: [admin], rowCount: 1 };
        if (params[0] === sessionTokenHash("tech-session-token-abcdef")) return { rows: [technician], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("COUNT(*)::integer count FROM users")) return { rows: [{ count: 1 }], rowCount: 1 };
      if (text.includes("FROM users WHERE lower(username)")) {
        return { rows: [{ ...admin, password_hash: adminHash }], rowCount: 1 };
      }
      if (text.includes("SELECT password_hash FROM users")) {
        return { rows: [{ password_hash: adminHash }], rowCount: 1 };
      }
      if (text.includes("INSERT INTO sessions")) return { rows: [], rowCount: 1 };
      if (text.includes("DELETE FROM sessions")) return { rows: [], rowCount: 0 };
      return { rows: [{ "?column?": 1 }], rowCount: 1 };
    },
  };
}

function testApp() {
  return buildApp({
    pool: fakePool(),
    config: { trustProxy: false, database: { connectionString: "postgres://unused" } },
    logger: false,
  });
}

const adminAuth = { authorization: "Bearer admin-session-token-abcdef" };
const technicianAuth = { authorization: "Bearer tech-session-token-abcdef" };

test("health endpoint reports ready without authentication", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.headers["x-content-type-options"], "nosniff");
});

test("business endpoints require authentication", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/customers" });
  assert.equal(response.statusCode, 401);
  assert.match(response.json().error, /Authentication required/);
});

test("expired or unknown sessions are rejected", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "GET",
    url: "/api/customers",
    headers: { authorization: "Bearer unknown-session-token-abcdef" },
  });
  assert.equal(response.statusCode, 401);
  assert.match(response.json().error, /Session expired/);
});

test("invalid customer payload returns a client error", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/customers",
    headers: adminAuth,
    payload: { name: " " },
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /name is required/);
});

test("technicians cannot access user management", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/users", headers: technicianAuth });
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /Admin access required/);
});

test("restore rejects files that are not PostgreSQL dumps", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "PUT",
    url: "/api/backups/database",
    headers: { ...adminAuth, "content-type": "application/octet-stream" },
    payload: Buffer.from("not a database"),
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /Invalid PostgreSQL backup/);
});

test("login returns a session for valid credentials", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "correct-horse-battery" },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.equal(body.user.username, "admin");
  assert.equal(body.user.role, "admin");
});

test("login rejects invalid credentials", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { username: "admin", password: "wrong-password" },
  });
  assert.equal(response.statusCode, 401);
  assert.match(response.json().error, /Invalid username or password/);
});

test("auth status reports the current user", async (t) => {
  const app = testApp();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: "/api/auth/status", headers: adminAuth });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    setupRequired: false,
    user: { id: 1, username: "admin", displayName: "Admin", role: "admin", active: true, createdAt: null },
  });
});
