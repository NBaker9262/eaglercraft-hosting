import crypto from 'node:crypto';
import db, { hashPassword } from './db.js';
import { getSetting } from './settings.js';

const COOKIE = 'eagler_sess';

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

export function audit(userId, action, detail, ip) {
  db.prepare('INSERT INTO audit_log (ts, user_id, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), userId, action, detail ?? null, ip ?? null);
}

// --- Lockout with exponential backoff (plan section 10.5) -----------------

export function lockoutState(username, ip) {
  const key = `${username}|${ip}`;
  const row = db.prepare('SELECT fails, until FROM lockouts WHERE key = ?').get(key);
  if (row && row.until > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((row.until - Date.now()) / 1000) };
  }
  return { locked: false, fails: row ? row.fails : 0, key };
}

export function registerFailedLogin(username, ip) {
  const key = `${username}|${ip}`;
  const maxAttempts = Number(getSetting('security.login_max_attempts'));
  const base = Number(getSetting('security.lockout_base_seconds'));
  const row = db.prepare('SELECT fails, until FROM lockouts WHERE key = ?').get(key);
  const fails = (row ? row.fails : 0) + 1;
  // The lockout only starts once too many attempts accumulate in a row.
  if (fails >= maxAttempts) {
    const waitSec = Math.min(base * 2 ** (fails - maxAttempts), 3600);
    const until = Date.now() + waitSec * 1000;
    db.prepare(
      'INSERT INTO lockouts (key, fails, until) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, until = excluded.until'
    ).run(key, fails, until);
    return waitSec;
  }
  db.prepare(
    'INSERT INTO lockouts (key, fails, until) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET fails = excluded.fails'
  ).run(key, fails);
  return 0;
}

export function clearLockout(key) {
  db.prepare('DELETE FROM lockouts WHERE key = ?').run(key);
}

// --- Sessions ---------------------------------------------------------------

export function createSession(user, ua) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const now = Date.now();
  const admin = user.role === 'admin';
  const idle = (admin ? getSetting('security.admin_idle_minutes') : getSetting('security.session_idle_minutes')) * 60_000;
  const absolute = (admin ? getSetting('security.admin_absolute_minutes') : getSetting('security.session_absolute_minutes')) * 60_000;
  const expiresAt = Math.min(now + idle, now + absolute);
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen, expires_at, ua_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sha256(token), user.id, csrf, now, now, expiresAt, ua ? sha256(ua) : null);
  return { token, csrf };
}

export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function getSession(req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user || user.disabled) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
    return null;
  }
  return { session: row, user };
}

export function touchSession(s) {
  const admin = s.user.role === 'admin';
  const idle = (admin ? getSetting('security.admin_idle_minutes') : getSetting('security.session_idle_minutes')) * 60_000;
  const now = Date.now();
  const expiresAt = Math.min(now + idle, s.session.created_at +
    (admin ? getSetting('security.admin_absolute_minutes') : getSetting('security.session_absolute_minutes')) * 60_000);
  db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
    .run(now, expiresAt, s.session.token_hash);
}

export function destroySession(req) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}

export { COOKIE, sha256, hashPassword };
