import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const DATA_DIR = process.env.DATA_DIR || '/data';
const db = new DatabaseSync(path.join(DATA_DIR, 'eagler.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pw_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  disabled INTEGER NOT NULL DEFAULT 0,
  quota_bytes INTEGER,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua_hash TEXT
);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_version TEXT NOT NULL,
  world_name TEXT NOT NULL,
  revision INTEGER NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, client_version, world_name)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  key TEXT UNIQUE NOT NULL,
  message TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  username TEXT NOT NULL,
  ip TEXT,
  ok INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lockouts (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_user ON backups(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ts ON login_attempts(ts);
`);

export function hashPassword(pw) {
  return bcrypt.hashSync(pw, 12);
}

export function verifyPassword(pw, hash) {
  return bcrypt.compareSync(pw, hash);
}

export default db;
