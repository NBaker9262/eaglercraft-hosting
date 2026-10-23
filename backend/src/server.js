import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db, { hashPassword, verifyPassword } from './db.js';
import { getSetting, setSetting, DEFAULTS as DEFAULT_SETTINGS } from './settings.js';
import {
  createSession, setSessionCookie, clearSessionCookie, getSession, touchSession,
  destroySession, parseCookies, clientIp, audit, lockoutState, registerFailedLogin, clearLockout,
} from './auth.js';
import { listForUser, handleUpload, canDownload, getBackup } from './backups.js';
import { handleAdmin } from './admin.js';
import { loginPage, launcherPage, clientIndexHtml, esc } from './pagegen.js';
import { renderNetworkConfigs } from './render.js';
import { startAlertLoop } from './alerts.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');

// Client folders on disk that are not registered yet are registered and
// enabled automatically (drop-in installs, the placeholder build).
function scanVersions() {
  if (!fs.existsSync(process.env.CLIENT_DIR || '/srv/client')) return;
  for (const entry of fs.readdirSync(process.env.CLIENT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!fs.existsSync(path.join(process.env.CLIENT_DIR, entry.name, 'index.html'))) continue;
    const known = db.prepare('SELECT name FROM versions WHERE name = ?').get(entry.name);
    if (known) continue;
    const anyDefault = db.prepare('SELECT 1 FROM versions WHERE is_default = 1').get();
    db.prepare('INSERT INTO versions (name, enabled, is_default, uploaded_at) VALUES (?, 1, ?, ?)')
      .run(entry.name, anyDefault ? 0 : 1, Date.now());
    console.log(`registered client version ${entry.name}`);
  }
}

// --- First boot: create the admin account --------------------------------
function bootstrapAdmin() {
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return;
  const password = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '').slice(0, 24);
  db.prepare('INSERT INTO users (username, pw_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run('admin', hashPassword(password), 'admin', Date.now());
  const file = path.join(DATA_DIR, 'admin-credentials.txt');
  fs.writeFileSync(file, `admin / ${password}\n(Shown once here; change it after first login.)\n`, { mode: 0o600 });
  console.log('============================================================');
  console.log('Created initial admin account. Credentials written to:');
  console.log(`  ${file}`);
  console.log(`  admin / ${password}`);
  console.log('============================================================');
}

// --- Small helpers ---------------------------------------------------------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function unauthorized(res) {
  res.writeHead(401, { 'content-type': 'text/plain' });
  res.end('unauthorized');
}
function readJson(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function readForm(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      resolve(Object.fromEntries(params));
    });
    req.on('error', reject);
  });
}

// --- Login ------------------------------------------------------------------
async function doLogin(req, res, credentials, viaForm) {
  const ip = clientIp(req);
  const username = String(credentials.username || '').trim();
  const password = String(credentials.password || '');

  const lock = lockoutState(username, ip);
  if (lock.locked) {
    audit(null, 'login_locked_out', username, ip);
    if (viaForm) {
      res.writeHead(429, { 'content-type': 'text/html' });
      return res.end(loginPage(`Too many failed attempts. Try again in ${lock.retryAfterSec} seconds.`, true));
    }
    res.writeHead(429, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: `locked, retry in ${lock.retryAfterSec}s` }));
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = user && !user.disabled && verifyPassword(password, user.pw_hash);
  db.prepare('INSERT INTO login_attempts (ts, username, ip, ok) VALUES (?, ?, ?, ?)')
    .run(Date.now(), username, ip, ok ? 1 : 0);

  if (!ok) {
    const waitSec = registerFailedLogin(username, ip);
    audit(null, 'login_failed', username, ip);
    if (viaForm) {
      res.writeHead(401, { 'content-type': 'text/html' });
      return res.end(loginPage(waitSec ? `Too many failed attempts. Locked for ${waitSec}s.` : 'Wrong username or password.', true));
    }
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'wrong username or password' }));
  }

  clearLockout(lock.key ?? `${username}|${ip}`);
  db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), user.id);
  const { token, csrf } = createSession(user, req.headers['user-agent']);
  setSessionCookie(res, token);
  audit(user.id, 'login_ok', null, ip);
  if (viaForm) {
    res.writeHead(302, { location: '/' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, csrf, username: user.username, role: user.role }));
}

// --- Router -------------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, 'http://internal');
  const p = url.pathname;
  const method = req.method;

  // Public routes
  if (method === 'GET' && p === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(loginPage());
  }
  if (method === 'GET' && p === '/login-assets/style.css') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'style.css')));
  }
  if (method === 'POST' && p === '/api/login') {
    return doLogin(req, res, await readJson(req), false);
  }
  if (method === 'POST' && p === '/api/login-form') {
    return doLogin(req, res, await readForm(req), true);
  }
  if (method === 'POST' && p === '/api/logout') {
    destroySession(req);
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }
  if (method === 'GET' && p === '/api/auth/check') {
    const s = getSession(req);
    if (!s) return unauthorized(res);
    touchSession(s);
    if (url.searchParams.get('role') === 'admin' && s.user.role !== 'admin') return unauthorized(res);
    return json(res, 200, { ok: true, role: s.user.role });
  }
  if (method === 'GET' && p === '/healthz') return json(res, 200, { ok: true });

  // Everything below needs a session.
  const s = getSession(req);
  if (!s) {
    if (method === 'GET' && !p.startsWith('/api/')) {
      res.writeHead(302, { location: '/login' });
      return res.end();
    }
    return unauthorized(res);
  }
  touchSession(s);
  const user = s.user;

  // CSRF on state-changing API calls (plan 10.2)
  if (method !== 'GET' && p.startsWith('/api/') && p !== '/api/login' && p !== '/api/login-form') {
    if (req.headers['x-csrf-token'] !== s.session.csrf) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      return res.end('bad csrf token');
    }
  }

  if (method === 'GET' && p === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(launcherPage(user));
  }
  if (method === 'GET' && p === '/api/me') {
    return json(res, 200, { username: user.username, id: user.id, role: user.role, csrf: s.session.csrf });
  }
  if (method === 'GET' && p === '/api/versions') {
    const rows = db.prepare('SELECT name, is_default FROM versions WHERE enabled = 1 ORDER BY is_default DESC, name').all();
    return json(res, 200, rows);
  }

  if (method === 'GET' && p === '/api/backups') {
    return json(res, 200, listForUser(user.id));
  }
  let m = p.match(/^\/api\/backups\/([^/]+)\/([^/]+)$/);
  if (method === 'PUT' && m) {
    return handleUpload(req, res, user, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  }
  m = p.match(/^\/api\/backups\/(\d+)\/download$/);
  if (method === 'GET' && m) {
    const b = getBackup(Number(m[1]));
    if (!b || !canDownload(b, user)) return unauthorized(res);
    if (!fs.existsSync(b.path)) { res.writeHead(404); return res.end('backup file missing'); }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': b.size_bytes,
      'content-disposition': `attachment; filename="${b.world_name.replace(/[^A-Za-z0-9._-]/g, '_')}.epk"`,
    });
    return fs.createReadStream(b.path).pipe(res);
  }
  m = p.match(/^\/api\/backups\/(\d+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) {
    const b = getBackup(Number(m[1]));
    if (!b || (b.user_id !== user.id && user.role !== 'admin')) return unauthorized(res);
    if (method === 'DELETE') {
      db.prepare('DELETE FROM backups WHERE id = ?').run(b.id);
      fs.rm(b.path, { force: true }, () => {});
      audit(user.id, 'backup_deleted', `#${b.id} (${b.world_name})`, clientIp(req));
      return json(res, 200, { ok: true });
    }
    const body = await readJson(req);
    if (body.visibility !== undefined) {
      db.prepare('UPDATE backups SET visibility = ? WHERE id = ?')
        .run(body.visibility === 'shared' ? 'shared' : 'private', b.id);
    }
    return json(res, 200, { ok: true });
  }

  // Per-user generated client index.html
  m = p.match(/^\/play\/([^/]+)\/index\.html$/);
  if (method === 'GET' && m) {
    const version = decodeURIComponent(m[1]);
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(version)) { res.writeHead(400); return res.end('bad version'); }
    const enabled = db.prepare('SELECT 1 FROM versions WHERE name = ? AND enabled = 1').get(version);
    if (!enabled) { res.writeHead(404); return res.end('version not installed'); }
    const html = clientIndexHtml(user, version);
    if (html === null) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;background:#1c1c24;color:#eee"><h2>Client files for ${esc(version)} are not installed yet.</h2><p>The admin can upload a client zip on the admin page (Versions section).</p><p><a href="/" style="color:#8ab4f8">Back</a></p></body></html>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }

  // Admin UI + API
  if (p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return unauthorized(res);
    if (p === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html')));
    }
    if (p.startsWith('/admin/assets/')) {
      const name = path.basename(p);
      const file = path.join(PUBLIC_DIR, 'admin', name);
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : 'application/javascript' });
      return res.end(fs.readFileSync(file));
    }
    if (p.startsWith('/api/admin/')) return handleAdmin(req, res, user, p);
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

bootstrapAdmin();
// Seed the generated TURN credentials from .env into settings on first boot.
if (!getSetting('turn.password') && process.env.TURN_PASSWORD) {
  setSetting('turn.password', process.env.TURN_PASSWORD);
}
if (getSetting('turn.username') === DEFAULT_SETTINGS['turn.username'] && process.env.TURN_USERNAME) {
  setSetting('turn.username', process.env.TURN_USERNAME);
}
scanVersions();
renderNetworkConfigs();
startAlertLoop();

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error(`${req.method} ${req.url} failed:`, err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal server error');
  });
});

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => console.log(`eagler backend listening on :${PORT}`));
