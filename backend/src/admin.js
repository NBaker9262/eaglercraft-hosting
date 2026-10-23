import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import db, { hashPassword } from './db.js';
import { setSetting, allSettings, getSetting } from './settings.js';
import { audit, clientIp } from './auth.js';
import { statusSnapshot } from './alerts.js';
import { raiseAlert } from './alerts.js';
import { renderNetworkConfigs } from './render.js';
import { safeName } from './backups.js';

const execFileP = promisify(execFile);
const CLIENT_DIR = process.env.CLIENT_DIR || '/srv/client';

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
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
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

export async function handleAdmin(req, res, user, pathname) {
  const method = req.method;
  const seg = pathname.replace(/^\/api\/admin\/?/, '').split('/').filter(Boolean);

  // --- status / alerts ----------------------------------------------------
  if (method === 'GET' && seg[0] === 'status') {
    const open = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE resolved = 0').get().n;
    return json(res, 200, { ...statusSnapshot(), open_alerts: open });
  }
  if (method === 'GET' && seg[0] === 'alerts') {
    return json(res, 200, db.prepare('SELECT * FROM alerts ORDER BY ts DESC LIMIT 200').all());
  }
  if (method === 'POST' && seg[0] === 'alerts' && seg[1] === 'resolve-all') {
    db.prepare('UPDATE alerts SET resolved = 1 WHERE resolved = 0').run();
    audit(user.id, 'alerts_resolved_all', null, clientIp(req));
    return json(res, 200, { ok: true });
  }
  // Re-hash every backup and compare against the stored checksum (plan 13.9).
  if (method === 'POST' && seg[0] === 'integrity-check') {
    const rows = db.prepare('SELECT * FROM backups').all();
    let missing = 0, mismatched = 0;
    for (const b of rows) {
      try {
        const h = crypto.createHash('sha256');
        h.update(fs.readFileSync(b.path));
        if (h.digest('hex') !== b.sha256) { mismatched++; raiseAlert('warning', `integrity-${b.id}`, `Backup #${b.id} (${b.world_name}) failed its checksum — the file on disk changed.`); }
      } catch {
        missing++;
        raiseAlert('warning', `integrity-${b.id}`, `Backup #${b.id} (${b.world_name}) file is missing from disk.`);
      }
    }
    audit(user.id, 'integrity_check', `${rows.length} checked, ${missing} missing, ${mismatched} corrupt`, clientIp(req));
    return json(res, 200, { checked: rows.length, missing, mismatched });
  }

  // --- users ---------------------------------------------------------------
  if (method === 'GET' && seg[0] === 'users') {
    const rows = db.prepare(
      'SELECT id, username, role, disabled, quota_bytes, created_at, last_login FROM users ORDER BY id'
    ).all();
    return json(res, 200, rows);
  }
  if (method === 'POST' && seg[0] === 'users' && !seg[1]) {
    const b = await readJson(req);
    const username = String(b.username || '').trim();
    if (!/^[a-zA-Z0-9_-]{2,32}$/.test(username)) return json(res, 400, { error: 'username must be 2-32 chars: letters, digits, _ -' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return json(res, 409, { error: 'username taken' });
    if (typeof b.password !== 'string' || b.password.length < 10) return json(res, 400, { error: 'password must be at least 10 characters' });
    const info = db.prepare(
      'INSERT INTO users (username, pw_hash, role, quota_bytes, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hashPassword(b.password), b.role === 'admin' ? 'admin' : 'player',
      b.quota_bytes ?? null, Date.now());
    audit(user.id, 'user_created', username, clientIp(req));
    return json(res, 200, { id: Number(info.lastInsertRowid) });
  }
  if ((method === 'PATCH' || method === 'DELETE') && seg[0] === 'users' && seg[1]) {
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(seg[1]));
    if (!target) return json(res, 404, { error: 'no such user' });
    if (target.id === user.id && method === 'DELETE') return json(res, 400, { error: 'cannot delete yourself' });
    if (method === 'DELETE') {
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      audit(user.id, 'user_deleted', target.username, clientIp(req));
      return json(res, 200, { ok: true });
    }
    const b = await readJson(req);
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 10) return json(res, 400, { error: 'password must be at least 10 characters' });
      db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(b.password), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    if (b.disabled !== undefined) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(b.disabled ? 1 : 0, target.id);
      if (b.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    if (b.quota_bytes !== undefined) {
      db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(b.quota_bytes, target.id);
    }
    audit(user.id, 'user_updated', `${target.username}: ${Object.keys(b).join(',')}`, clientIp(req));
    return json(res, 200, { ok: true });
  }

  // --- settings --------------------------------------------------------------
  if (method === 'GET' && seg[0] === 'settings') {
    return json(res, 200, allSettings());
  }
  if (method === 'PUT' && seg[0] === 'settings') {
    const b = await readJson(req, 5_000_000);
    const allowed = Object.keys(allSettings());
    let networkChanged = false;
    for (const [k, v] of Object.entries(b)) {
      if (!allowed.includes(k)) continue;
      if (k.startsWith('turn.')) networkChanged = true;
      setSetting(k, v);
    }
    audit(user.id, 'settings_updated', Object.keys(b).join(','), clientIp(req));
    if (networkChanged) renderNetworkConfigs();
    return json(res, 200, { ok: true, network_restart_needed: networkChanged });
  }

  // --- audit log ---------------------------------------------------------------
  if (method === 'GET' && seg[0] === 'audit') {
    const limit = Math.min(500, Number(seg[1] || 200));
    return json(res, 200, db.prepare('SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ?').all(limit));
  }

  // --- backups (admin view of everything) --------------------------------------
  if (method === 'GET' && seg[0] === 'backups') {
    const rows = db.prepare(
      'SELECT b.*, u.username AS owner FROM backups b JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC'
    ).all();
    return json(res, 200, rows);
  }
  if (method === 'PATCH' && seg[0] === 'backups' && seg[1]) {
    const b = await readJson(req);
    const target = db.prepare('SELECT * FROM backups WHERE id = ?').get(Number(seg[1]));
    if (!target) return json(res, 404, { error: 'no such backup' });
    if (b.visibility !== undefined) {
      db.prepare('UPDATE backups SET visibility = ? WHERE id = ?').run(b.visibility === 'shared' ? 'shared' : 'private', target.id);
    }
    if (b.owner_username !== undefined) {
      const owner = db.prepare('SELECT id FROM users WHERE username = ?').get(String(b.owner_username));
      if (!owner) return json(res, 404, { error: 'no such user' });
      db.prepare('UPDATE backups SET user_id = ? WHERE id = ?').run(owner.id, target.id);
    }
    audit(user.id, 'backup_updated', `#${target.id}`, clientIp(req));
    return json(res, 200, { ok: true });
  }
  if (method === 'DELETE' && seg[0] === 'backups' && seg[1]) {
    const target = db.prepare('SELECT * FROM backups WHERE id = ?').get(Number(seg[1]));
    if (!target) return json(res, 404, { error: 'no such backup' });
    db.prepare('DELETE FROM backups WHERE id = ?').run(target.id);
    fs.rm(target.path, { force: true }, () => {});
    audit(user.id, 'backup_deleted', `#${target.id} (${target.world_name})`, clientIp(req));
    return json(res, 200, { ok: true });
  }

  // --- client versions -----------------------------------------------------------
  if (method === 'GET' && seg[0] === 'versions') {
    const rows = db.prepare('SELECT * FROM versions ORDER BY name').all();
    const installed = fs.existsSync(CLIENT_DIR)
      ? fs.readdirSync(CLIENT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      : [];
    const files = {};
    for (const v of rows) {
      const dir = path.join(CLIENT_DIR, v.name);
      files[v.name] = fs.existsSync(dir) ? fs.readdirSync(dir).slice(0, 10) : [];
    }
    for (const name of installed) {
      if (!rows.find((r) => r.name === name)) {
        files[name] = fs.readdirSync(path.join(CLIENT_DIR, name)).slice(0, 10);
        rows.push({ name, enabled: 0, is_default: 0, uploaded_at: 0, orphan: true });
      }
    }
    return json(res, 200, rows.map((r) => ({ ...r, files: files[r.name] ?? [] })));
  }
  if (method === 'POST' && seg[0] === 'versions' && seg[1]) {
    const name = safeName(seg[1], 32);
    if (!name) return json(res, 400, { error: 'invalid version name' });
    const dest = path.join(CLIENT_DIR, name);
    const zipPath = `/tmp/version-${crypto.randomUUID()}.zip`;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      req.on('data', (c) => out.write(c));
      req.on('end', () => out.end(resolve));
      req.on('error', reject);
      out.on('error', reject);
    });
    try {
      fs.mkdirSync(dest, { recursive: true });
      await execFileP('unzip', ['-o', '-q', zipPath, '-d', dest]);
      if (!fs.existsSync(path.join(dest, 'index.html'))) {
        fs.rmSync(dest, { recursive: true, force: true });
        return json(res, 400, { error: 'zip does not contain an index.html at its root' });
      }
      db.prepare(
        'INSERT INTO versions (name, enabled, is_default, uploaded_at) VALUES (?, 1, 0, ?) ON CONFLICT(name) DO UPDATE SET uploaded_at = excluded.uploaded_at'
      ).run(name, Date.now());
      audit(user.id, 'version_uploaded', name, clientIp(req));
      return json(res, 200, { ok: true });
    } catch (err) {
      return json(res, 500, { error: `unzip failed: ${err.message}` });
    } finally {
      fs.rm(zipPath, { force: true }, () => {});
    }
  }
  if ((method === 'PATCH' || method === 'DELETE') && seg[0] === 'versions' && seg[1]) {
    const name = safeName(seg[1], 32);
    const row = db.prepare('SELECT * FROM versions WHERE name = ?').get(name);
    if (method === 'DELETE') {
      if (row?.is_default) return json(res, 400, { error: 'unset default first' });
      db.prepare('DELETE FROM versions WHERE name = ?').run(name);
      fs.rmSync(path.join(CLIENT_DIR, name), { recursive: true, force: true });
      audit(user.id, 'version_deleted', name, clientIp(req));
      return json(res, 200, { ok: true });
    }
    const b = await readJson(req);
    if (b.is_default !== undefined) {
      db.prepare('UPDATE versions SET is_default = 0').run();
      db.prepare('UPDATE versions SET is_default = ? WHERE name = ?').run(b.is_default ? 1 : 0, name);
    }
    if (b.enabled !== undefined) {
      if (row?.is_default && !b.enabled) return json(res, 400, { error: 'cannot disable the default version' });
      db.prepare('UPDATE versions SET enabled = ? WHERE name = ?').run(b.enabled ? 1 : 0, name);
    }
    audit(user.id, 'version_updated', `${name}: ${Object.keys(b).join(',')}`, clientIp(req));
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
}
