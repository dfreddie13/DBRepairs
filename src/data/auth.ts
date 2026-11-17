import { invoke } from "@tauri-apps/api/core";
import { api, setSessionToken, getSessionToken } from "./api";
import { getDatabase } from "./database";
import { isServerMode } from "./runtime";

export type UserRole = "admin" | "technician";

export type AuthUser = {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  active?: boolean;
  createdAt?: string | null;
};

export type UserRecord = AuthUser & {
  active: boolean;
  createdAt: string | null;
};

export type AuthStatus = {
  setupRequired: boolean;
  user: AuthUser | null;
};

export type UserInput = {
  username: string;
  displayName: string;
  password: string;
  role: UserRole;
};

export type UserUpdateInput = {
  displayName?: string;
  role?: UserRole;
  active?: boolean;
  password?: string;
};

type UserRow = {
  id: number;
  username: string;
  display_name: string;
  password_hash?: string;
  role: UserRole;
  active: number | boolean;
  created_at?: string | null;
};

type SessionUserRow = {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  active: number | boolean;
  created_at?: string | null;
};

export const MIN_PASSWORD_LENGTH = 8;

export function isValidUsername(value: string): boolean {
  return /^[a-zA-Z0-9._-]{3,32}$/.test(value.trim());
}

function toUser(row: SessionUserRow): AuthUser {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active === true || Number(row.active) === 1,
    createdAt: row.created_at ?? null,
  };
}

function toUserRecord(row: SessionUserRow): UserRecord {
  return { ...toUser(row), active: row.active === true || Number(row.active) === 1, createdAt: row.created_at ?? null };
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function localTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function sessionExpiry(): string {
  return localTimestamp(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomHex(16);
  return invoke<string>("auth_hash_password", { password, salt });
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return invoke<boolean>("auth_verify_password", { password, hash });
}

async function startLocalSession(userId: number): Promise<void> {
  const db = await getDatabase();
  const token = randomHex(32);
  await db.execute("DELETE FROM sessions WHERE expires_at <= datetime('now')");
  await db.execute("INSERT INTO sessions (token,user_id,expires_at) VALUES (?,?,?)", [
    token,
    userId,
    sessionExpiry(),
  ]);
  setSessionToken(token);
}

export async function getAuthStatus(): Promise<AuthStatus> {
  if (isServerMode) return api<AuthStatus>("/auth/status");

  const db = await getDatabase();
  const token = getSessionToken();
  if (token) {
    const rows = await db.select<SessionUserRow[]>(
      `SELECT u.id, u.username, u.display_name, u.role, u.active, u.created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ?
          AND s.expires_at > datetime('now')
          AND u.active = 1
        LIMIT 1`,
      [token],
    );
    if (rows[0]) return { setupRequired: false, user: toUser(rows[0]) };
    await db.execute("DELETE FROM sessions WHERE token = ?", [token]);
    setSessionToken(null);
  }

  const count = await db.select<{ count: number }[]>("SELECT COUNT(*) count FROM users");
  return { setupRequired: Number(count[0]?.count ?? 0) === 0, user: null };
}

export async function login(username: string, password: string): Promise<AuthUser> {
  if (isServerMode) {
    const result = await api<{ token: string; user: AuthUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setSessionToken(result.token);
    return result.user;
  }

  const db = await getDatabase();
  const rows = await db.select<UserRow[]>(
    "SELECT id, username, display_name, password_hash, role, active, created_at FROM users WHERE lower(username) = lower(?) LIMIT 1",
    [username.trim()],
  );
  const row = rows[0];
  const valid = row ? await verifyPassword(password, row.password_hash || "") : false;
  if (!row || !valid || !row.active) throw new Error("invalid-credentials");
  await startLocalSession(Number(row.id));
  return toUser(row);
}

export async function setupAdmin(input: { username: string; displayName: string; password: string }): Promise<AuthUser> {
  if (isServerMode) {
    const result = await api<{ token: string; user: AuthUser }>("/auth/setup", {
      method: "POST",
      body: JSON.stringify(input),
    });
    setSessionToken(result.token);
    return result.user;
  }

  const db = await getDatabase();
  const count = await db.select<{ count: number }[]>("SELECT COUNT(*) count FROM users");
  if (Number(count[0]?.count ?? 0) > 0) throw new Error("setup-complete");

  const hash = await hashPassword(input.password);
  const result = await db.execute(
    "INSERT INTO users (username, display_name, password_hash, role, active) VALUES (?,?,?,'admin',1)",
    [input.username.trim(), input.displayName.trim(), hash],
  );
  const id = Number(result.lastInsertId);
  await startLocalSession(id);
  return {
    id,
    username: input.username.trim(),
    displayName: input.displayName.trim(),
    role: "admin",
    active: true,
    createdAt: null,
  };
}

export async function logout(): Promise<void> {
  const token = getSessionToken();
  if (isServerMode) {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // The session may already be expired; clearing the local token is enough.
    }
  } else if (token) {
    const db = await getDatabase();
    await db.execute("DELETE FROM sessions WHERE token = ?", [token]);
  }
  setSessionToken(null);
}

export async function listUsers(): Promise<UserRecord[]> {
  if (isServerMode) return api<UserRecord[]>("/users");
  const db = await getDatabase();
  const rows = await db.select<SessionUserRow[]>(
    "SELECT id, username, display_name, role, active, created_at FROM users ORDER BY lower(username), id",
  );
  return rows.map(toUserRecord);
}

export async function createUser(input: UserInput): Promise<void> {
  if (!isValidUsername(input.username)) throw new Error("invalid-username");
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new Error("weak-password");

  if (isServerMode) {
    await api("/users", { method: "POST", body: JSON.stringify(input) });
    return;
  }

  const db = await getDatabase();
  const hash = await hashPassword(input.password);
  await db.execute(
    "INSERT INTO users (username, display_name, password_hash, role, active) VALUES (?,?,?,?,1)",
    [input.username.trim(), input.displayName.trim(), hash, input.role],
  );
}

export async function updateUser(id: number, input: UserUpdateInput): Promise<void> {
  if (input.password && input.password.length < MIN_PASSWORD_LENGTH) throw new Error("weak-password");

  if (isServerMode) {
    await api(`/users/${id}`, { method: "PUT", body: JSON.stringify(input) });
    return;
  }

  const db = await getDatabase();
  const rows = await db.select<UserRow[]>(
    "SELECT id, username, display_name, password_hash, role, active, created_at FROM users WHERE id = ? LIMIT 1",
    [id],
  );
  const current = rows[0];
  if (!current) throw new Error("not-found");

  const status = await getAuthStatus();
  const currentActive = current.active === true || Number(current.active) === 1;
  if (status.user?.id === id && (input.active === false || (input.role && input.role !== "admin"))) {
    throw new Error("cannot-change-self");
  }
  if (current.role === "admin" && currentActive && (input.role === "technician" || input.active === false)) {
    const admins = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) count FROM users WHERE role = 'admin' AND active = 1 AND id <> ?",
      [id],
    );
    if (Number(admins[0]?.count ?? 0) === 0) throw new Error("last-admin");
  }

  const passwordHash = input.password ? await hashPassword(input.password) : current.password_hash || "";
  await db.execute(
    `UPDATE users
        SET display_name = ?, role = ?, active = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [
      input.displayName ?? current.display_name,
      input.role ?? current.role,
      (input.active ?? Boolean(current.active)) ? 1 : 0,
      passwordHash,
      id,
    ],
  );
}

export async function deleteUser(id: number): Promise<void> {
  if (isServerMode) {
    await api(`/users/${id}`, { method: "DELETE" });
    return;
  }

  const db = await getDatabase();
  const status = await getAuthStatus();
  if (status.user?.id === id) throw new Error("cannot-delete-self");

  const rows = await db.select<UserRow[]>("SELECT id, username, display_name, role, active FROM users WHERE id = ? LIMIT 1", [id]);
  const target = rows[0];
  if (!target) throw new Error("not-found");

  if (target.role === "admin" && target.active) {
    const admins = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) count FROM users WHERE role = 'admin' AND active = 1 AND id <> ?",
      [id],
    );
    if (Number(admins[0]?.count ?? 0) === 0) throw new Error("last-admin");
  }

  await db.execute("DELETE FROM users WHERE id = ?", [id]);
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < MIN_PASSWORD_LENGTH) throw new Error("weak-password");

  if (isServerMode) {
    await api("/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    return;
  }

  const db = await getDatabase();
  const status = await getAuthStatus();
  if (!status.user) throw new Error("not-authenticated");
  const rows = await db.select<UserRow[]>("SELECT password_hash FROM users WHERE id = ? LIMIT 1", [status.user.id]);
  const row = rows[0];
  if (!row || !(await verifyPassword(currentPassword, row.password_hash || ""))) {
    throw new Error("wrong-password");
  }
  const hash = await hashPassword(newPassword);
  const token = getSessionToken();
  await db.execute("UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [hash, status.user.id]);
  await db.execute("DELETE FROM sessions WHERE user_id = ? AND token <> ?", [status.user.id, token || ""]);
}

export async function currentUser(): Promise<AuthUser | null> {
  return (await getAuthStatus()).user;
}
