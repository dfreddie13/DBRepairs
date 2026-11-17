import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const HASH_PREFIX = "pbkdf2-sha256";
const ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const SESSION_DAYS = 30;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

const failures = new Map();

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, "sha256");
  return `${HASH_PREFIX}$${ITERATIONS}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== HASH_PREFIX) return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 1_000_000) return false;
  const salt = Buffer.from(parts[2], "hex");
  const expected = Buffer.from(parts[3], "hex");
  if (!salt.length || !expected.length) return false;
  if (salt.toString("hex") !== parts[2].toLowerCase()) return false;
  if (expected.toString("hex") !== parts[3].toLowerCase()) return false;
  const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function sessionToken() {
  return randomBytes(32).toString("hex");
}

export function sessionTokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name ?? row.displayName,
    role: row.role,
    active: row.active !== false,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

export async function userForToken(db, token) {
  if (!token) return null;
  const result = await db.query(
    `SELECT u.id, u.username, u.display_name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()
        AND u.active = true
      LIMIT 1`,
    [sessionTokenHash(token)],
  );
  return result.rowCount ? publicUser(result.rows[0]) : null;
}

export async function createSession(db, userId) {
  const token = sessionToken();
  await db.query("DELETE FROM sessions WHERE expires_at <= now()");
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
    [sessionTokenHash(token), userId, String(SESSION_DAYS)],
  );
  return token;
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [sessionTokenHash(token)]);
}

export function bearerToken(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,})$/.exec(header.trim());
  return match ? match[1] : null;
}

export function loginAllowed(key) {
  const entry = failures.get(key);
  if (!entry) return true;
  if (Date.now() > entry.resetAt) {
    failures.delete(key);
    return true;
  }
  return entry.count < LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLoginFailures(key) {
  failures.delete(key);
}

const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/status",
  "POST /api/auth/setup",
  "POST /api/auth/login",
]);

export function isPublicRoute(method, url) {
  return PUBLIC_ROUTES.has(`${method} ${String(url).split("?")[0]}`);
}
