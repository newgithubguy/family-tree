const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = path.join(dataDir, "family-tree.db");
const trustProxySetting = process.env.TRUST_PROXY;

if (typeof trustProxySetting === "string" && trustProxySetting.trim().length > 0) {
  const lowered = trustProxySetting.trim().toLowerCase();
  if (lowered === "true") {
    app.set("trust proxy", true);
  } else if (lowered === "false") {
    app.set("trust proxy", false);
  } else if (Number.isFinite(Number(trustProxySetting))) {
    app.set("trust proxy", Number(trustProxySetting));
  } else {
    app.set("trust proxy", trustProxySetting);
  }
} else {
  app.set("trust proxy", 1);
}

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
`);

const userColumns = db.prepare("PRAGMA table_info(users)").all();
if (!userColumns.some((column) => column.name === "is_disabled")) {
  db.exec("ALTER TABLE users ADD COLUMN is_disabled INTEGER NOT NULL DEFAULT 0;");
}
if (!userColumns.some((column) => column.name === "disabled_at")) {
  db.exec("ALTER TABLE users ADD COLUMN disabled_at TEXT;");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);");
db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);");

const getStateStmt = db.prepare("SELECT revision, updated_at AS updatedAt, payload FROM app_state WHERE id = 1");
const upsertStateStmt = db.prepare(`
  INSERT INTO app_state (id, revision, updated_at, payload)
  VALUES (1, @revision, @updatedAt, @payload)
  ON CONFLICT(id) DO UPDATE SET
    revision = excluded.revision,
    updated_at = excluded.updated_at,
    payload = excluded.payload
`);

const getUserByUsernameStmt = db.prepare(`
  SELECT id, username, password_hash AS passwordHash, is_admin AS isAdmin, is_disabled AS isDisabled, disabled_at AS disabledAt, created_at AS createdAt
  FROM users
  WHERE username = ?
`);

const getUserByIdStmt = db.prepare(`
  SELECT id, username, is_admin AS isAdmin, is_disabled AS isDisabled, disabled_at AS disabledAt, created_at AS createdAt
  FROM users
  WHERE id = ?
`);

const listUsersStmt = db.prepare(`
  SELECT id, username, is_admin AS isAdmin, is_disabled AS isDisabled, disabled_at AS disabledAt, created_at AS createdAt
  FROM users
  ORDER BY username COLLATE NOCASE ASC
`);

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, username, password_hash, is_admin, is_disabled, disabled_at, created_at)
  VALUES (@id, @username, @passwordHash, @isAdmin, @isDisabled, @disabledAt, @createdAt)
`);

const updateUserPasswordStmt = db.prepare("UPDATE users SET password_hash = ?, is_disabled = 0, disabled_at = NULL WHERE id = ?");
const setUserDisabledStmt = db.prepare("UPDATE users SET is_disabled = ?, disabled_at = ? WHERE id = ?");
const deleteUserByIdStmt = db.prepare("DELETE FROM users WHERE id = ?");
const deleteSessionsByUserIdStmt = db.prepare("DELETE FROM sessions WHERE user_id = ?");

const insertSessionStmt = db.prepare(`
  INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
  VALUES (@id, @userId, @tokenHash, @createdAt, @expiresAt)
`);

const getSessionByTokenHashStmt = db.prepare(`
  SELECT
    sessions.id,
    sessions.user_id AS userId,
    sessions.expires_at AS expiresAt,
    users.username,
    users.is_admin AS isAdmin,
    users.is_disabled AS isDisabled
  FROM sessions
  JOIN users ON users.id = sessions.user_id
  WHERE sessions.token_hash = ?
`);

const deleteSessionByTokenHashStmt = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
const deleteExpiredSessionsStmt = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");
const countUsersStmt = db.prepare("SELECT COUNT(*) AS total FROM users");

const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "family_tree_session";
const SESSION_SAME_SITE = process.env.SESSION_SAME_SITE || "Lax";
const COOKIE_SECURE_MODE = (process.env.COOKIE_SECURE_MODE || "auto").toLowerCase();

const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 10 * 60 * 1000);
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 8);
const LOGIN_BLOCK_MS = Number(process.env.LOGIN_BLOCK_MS || 15 * 60 * 1000);
const loginAttemptsByIp = new Map();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function scrubUser(user) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: !!user.isAdmin,
    isDisabled: !!user.isDisabled,
    disabledAt: user.disabledAt || null,
    createdAt: user.createdAt,
  };
}

function parseCookies(req) {
  const rawCookieHeader = req.header("cookie");
  if (!rawCookieHeader) {
    return {};
  }

  const cookies = {};
  const entries = rawCookieHeader.split(";");
  for (const entry of entries) {
    const eqIndex = entry.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = entry.slice(0, eqIndex).trim();
    const rawValue = entry.slice(eqIndex + 1).trim();
    if (!key) {
      continue;
    }
    try {
      cookies[key] = decodeURIComponent(rawValue);
    } catch (_error) {
      cookies[key] = rawValue;
    }
  }

  return cookies;
}

function getSessionTokenFromRequest(req) {
  const cookies = parseCookies(req);
  const cookieToken = cookies[SESSION_COOKIE_NAME];
  if (cookieToken) {
    return cookieToken;
  }

  const auth = req.header("authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  return auth.slice(7).trim();
}

function requestIsSecure(req) {
  if (req.secure) {
    return true;
  }

  const forwardedProto = String(req.header("x-forwarded-proto") || "").toLowerCase();
  return forwardedProto.split(",").some((value) => value.trim() === "https");
}

function shouldUseSecureCookie(req) {
  if (COOKIE_SECURE_MODE === "always") {
    return true;
  }
  if (COOKIE_SECURE_MODE === "never") {
    return false;
  }
  return requestIsSecure(req);
}

function buildCookieHeader(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  if (Number.isFinite(Number(options.maxAge))) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(Number(options.maxAge)))}`);
  }

  parts.push(`Path=${options.path || "/"}`);

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (options.secure) {
    parts.push("Secure");
  }

  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite}`);
  }

  return parts.join("; ");
}

function setSessionCookie(res, token, req, expiresAtIso) {
  const expiresAtMs = new Date(expiresAtIso).getTime();
  const maxAgeSeconds = Number.isFinite(expiresAtMs) ? Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000)) : 0;

  res.setHeader(
    "Set-Cookie",
    buildCookieHeader(SESSION_COOKIE_NAME, token, {
      maxAge: maxAgeSeconds,
      path: "/",
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: SESSION_SAME_SITE,
    }),
  );
}

function clearSessionCookie(res, req) {
  res.setHeader(
    "Set-Cookie",
    buildCookieHeader(SESSION_COOKIE_NAME, "", {
      maxAge: 0,
      path: "/",
      httpOnly: true,
      secure: shouldUseSecureCookie(req),
      sameSite: SESSION_SAME_SITE,
    }),
  );
}

function getClientIp(req) {
  const cfConnectingIp = String(req.header("cf-connecting-ip") || "").trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const forwardedFor = String(req.header("x-forwarded-for") || "").trim();
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return req.ip || req.socket.remoteAddress || "unknown";
}

function cleanupLoginAttemptEntry(entry, nowMs) {
  if (entry.blockedUntil > 0 && nowMs >= entry.blockedUntil) {
    entry.blockedUntil = 0;
    entry.failures.length = 0;
  }

  entry.failures = entry.failures.filter((timestamp) => nowMs - timestamp <= LOGIN_WINDOW_MS);
}

function getLoginAttemptEntry(ip) {
  const nowMs = Date.now();
  const entry = loginAttemptsByIp.get(ip) || { failures: [], blockedUntil: 0 };
  cleanupLoginAttemptEntry(entry, nowMs);
  loginAttemptsByIp.set(ip, entry);
  return entry;
}

function isLoginBlocked(ip) {
  const entry = getLoginAttemptEntry(ip);
  if (entry.blockedUntil > Date.now()) {
    return {
      blocked: true,
      retryAfterSeconds: Math.ceil((entry.blockedUntil - Date.now()) / 1000),
    };
  }

  return { blocked: false, retryAfterSeconds: 0 };
}

function registerFailedLoginAttempt(ip) {
  const nowMs = Date.now();
  const entry = getLoginAttemptEntry(ip);
  entry.failures.push(nowMs);
  entry.failures = entry.failures.filter((timestamp) => nowMs - timestamp <= LOGIN_WINDOW_MS);

  if (entry.failures.length >= LOGIN_MAX_ATTEMPTS) {
    entry.blockedUntil = nowMs + LOGIN_BLOCK_MS;
    entry.failures.length = 0;
  }

  loginAttemptsByIp.set(ip, entry);
}

function clearFailedLoginAttempts(ip) {
  loginAttemptsByIp.delete(ip);
}

function cleanExpiredSessions() {
  deleteExpiredSessionsStmt.run(new Date().toISOString());
}

function createSessionForUser(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  insertSessionStmt.run({
    id: crypto.randomUUID(),
    userId,
    tokenHash: hashToken(token),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

function createUser(username, password, isAdmin) {
  const normalizedUsername = String(username || "").trim();
  const rawPassword = String(password || "");

  if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
    return { error: "Username must be 3-64 characters." };
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedUsername)) {
    return { error: "Username can only contain letters, numbers, dot, underscore, and dash." };
  }

  if (rawPassword.length < 8 || rawPassword.length > 128) {
    return { error: "Password must be 8-128 characters." };
  }

  const existing = getUserByUsernameStmt.get(normalizedUsername);
  if (existing) {
    return { error: "Username already exists." };
  }

  const user = {
    id: crypto.randomUUID(),
    username: normalizedUsername,
    passwordHash: bcrypt.hashSync(rawPassword, 12),
    isAdmin: isAdmin ? 1 : 0,
    isDisabled: 0,
    disabledAt: null,
    createdAt: new Date().toISOString(),
  };

  insertUserStmt.run(user);
  return { user: scrubUser(user) };
}

function seedAdminAccount() {
  const totalUsers = countUsersStmt.get();
  if (Number(totalUsers?.total || 0) > 0) {
    return;
  }

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin12345";
  const created = createUser(adminUsername, adminPassword, true);

  if (created.error) {
    console.error(`Unable to create bootstrap admin account: ${created.error}`);
    return;
  }

  console.warn("Created initial admin account.");
  console.warn(`Username: ${adminUsername}`);
  console.warn("Change ADMIN_PASSWORD in docker-compose.yml for production use.");
}

function readState() {
  const row = getStateStmt.get();
  if (!row) {
    return {
      revision: 0,
      updatedAt: new Date().toISOString(),
      people: [],
      relationships: [],
    };
  }

  let parsed = { people: [], relationships: [] };
  try {
    parsed = JSON.parse(row.payload);
  } catch (_error) {
    parsed = { people: [], relationships: [] };
  }

  return {
    revision: row.revision,
    updatedAt: row.updatedAt,
    people: Array.isArray(parsed.people) ? parsed.people : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
  };
}

function writeState(people, relationships) {
  const current = readState();
  const next = {
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    payload: JSON.stringify({ people, relationships }),
  };

  upsertStateStmt.run(next);
  return {
    revision: next.revision,
    updatedAt: next.updatedAt,
  };
}

app.use(express.json({ limit: "1mb" }));

function authRequired(req, res, next) {
  cleanExpiredSessions();

  const token = getSessionTokenFromRequest(req);
  if (!token) {
    clearSessionCookie(res, req);
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const tokenHash = hashToken(token);
  const session = getSessionByTokenHashStmt.get(tokenHash);
  if (!session) {
    clearSessionCookie(res, req);
    res.status(401).json({ error: "Invalid session." });
    return;
  }

  if (session.expiresAt <= new Date().toISOString()) {
    deleteSessionByTokenHashStmt.run(tokenHash);
    clearSessionCookie(res, req);
    res.status(401).json({ error: "Session expired." });
    return;
  }

  if (session.isDisabled) {
    deleteSessionByTokenHashStmt.run(tokenHash);
    clearSessionCookie(res, req);
    res.status(403).json({ error: "Account is disabled." });
    return;
  }

  req.authToken = token;
  req.user = {
    id: session.userId,
    username: session.username,
    isAdmin: !!session.isAdmin,
  };

  next();
}

function adminRequired(req, res, next) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/auth/login", (req, res) => {
  cleanExpiredSessions();

  const ip = getClientIp(req);
  const throttle = isLoginBlocked(ip);
  if (throttle.blocked) {
    res.setHeader("Retry-After", String(throttle.retryAfterSeconds));
    res.status(429).json({
      error: "Too many login attempts. Please try again later.",
      retryAfterSeconds: throttle.retryAfterSeconds,
    });
    return;
  }

  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!username || !password) {
    res.status(400).json({ error: "Username and password are required." });
    return;
  }

  const user = getUserByUsernameStmt.get(username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    registerFailedLoginAttempt(ip);
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  if (user.isDisabled) {
    registerFailedLoginAttempt(ip);
    res.status(403).json({ error: "Account is disabled." });
    return;
  }

  clearFailedLoginAttempts(ip);

  const session = createSessionForUser(user.id);
  setSessionCookie(res, session.token, req, session.expiresAt);
  res.json({
    ok: true,
    expiresAt: session.expiresAt,
    user: scrubUser(user),
  });
});

app.post("/api/auth/logout", (req, res) => {
  const token = getSessionTokenFromRequest(req);
  if (token) {
    deleteSessionByTokenHashStmt.run(hashToken(token));
  }

  clearSessionCookie(res, req);
  res.json({ ok: true });
});

app.get("/api/auth/me", authRequired, (req, res) => {
  const user = getUserByIdStmt.get(req.user.id);
  if (!user) {
    res.status(401).json({ error: "Invalid user." });
    return;
  }

  res.json({
    ok: true,
    user: scrubUser(user),
  });
});

app.get("/api/admin/users", authRequired, adminRequired, (_req, res) => {
  const users = listUsersStmt.all().map(scrubUser);
  res.json({ ok: true, users });
});

app.post("/api/admin/users", authRequired, adminRequired, (req, res) => {
  const result = createUser(req.body?.username, req.body?.password, !!req.body?.isAdmin);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json({ ok: true, user: result.user });
});

app.post("/api/admin/users/:userId/reset-password", authRequired, adminRequired, (req, res) => {
  const userId = String(req.params?.userId || "").trim();
  const newPassword = String(req.body?.password || "");

  if (!userId) {
    res.status(400).json({ error: "User ID is required." });
    return;
  }

  if (newPassword.length < 8 || newPassword.length > 128) {
    res.status(400).json({ error: "Password must be 8-128 characters." });
    return;
  }

  const user = getUserByIdStmt.get(userId);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const newPasswordHash = bcrypt.hashSync(newPassword, 12);
  updateUserPasswordStmt.run(newPasswordHash, userId);
  deleteSessionsByUserIdStmt.run(userId);

  res.json({ ok: true, user: scrubUser(getUserByIdStmt.get(userId)) });
});

app.patch("/api/admin/users/:userId", authRequired, adminRequired, (req, res) => {
  const userId = String(req.params?.userId || "").trim();
  const disableRequested = req.body?.isDisabled;

  if (!userId) {
    res.status(400).json({ error: "User ID is required." });
    return;
  }

  if (typeof disableRequested !== "boolean") {
    res.status(400).json({ error: "Body must include isDisabled boolean." });
    return;
  }

  const user = getUserByIdStmt.get(userId);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  if (user.id === req.user.id && disableRequested) {
    res.status(400).json({ error: "You cannot disable your own account." });
    return;
  }

  const disabledAt = disableRequested ? new Date().toISOString() : null;
  setUserDisabledStmt.run(disableRequested ? 1 : 0, disabledAt, userId);

  if (disableRequested) {
    deleteSessionsByUserIdStmt.run(userId);
  }

  res.json({ ok: true, user: scrubUser(getUserByIdStmt.get(userId)) });
});

app.delete("/api/admin/users/:userId", authRequired, adminRequired, (req, res) => {
  const userId = String(req.params?.userId || "").trim();

  if (!userId) {
    res.status(400).json({ error: "User ID is required." });
    return;
  }

  const user = getUserByIdStmt.get(userId);
  if (!user) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  if (user.id === req.user.id) {
    res.status(400).json({ error: "You cannot delete your own account." });
    return;
  }

  deleteSessionsByUserIdStmt.run(userId);
  deleteUserByIdStmt.run(userId);

  res.json({ ok: true });
});

app.get("/api/state", authRequired, (_req, res) => {
  const state = readState();
  res.json(state);
});

app.put("/api/state", authRequired, (req, res) => {
  const people = req.body && Array.isArray(req.body.people) ? req.body.people : null;
  const relationships = req.body && Array.isArray(req.body.relationships) ? req.body.relationships : null;

  if (!people || !relationships) {
    res.status(400).json({ error: "Body must include people[] and relationships[]." });
    return;
  }

  const result = writeState(people, relationships);
  res.json({ ok: true, revision: result.revision, updatedAt: result.updatedAt });
});

seedAdminAccount();

app.listen(port, () => {
  console.log(`family-tree-api listening on port ${port}`);
});
