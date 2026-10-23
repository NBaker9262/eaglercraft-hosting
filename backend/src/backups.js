import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { getSetting } from './settings.js';
import { audit } from './auth.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/srv/backups';

// World names and version names become path segments; keep them strict.
export function safeName(s, max = 64) {
  const ok = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/.test(s) && !s.includes('..');
  return ok && s.length <= max ? s : null;
}

export function listForUser(userId) {
  return db.prepare(
    `SELECT b.*, u.username AS owner FROM backups b JOIN users u ON u.id = b.user_id
     WHERE b.user_id = ? OR b.visibility = 'shared' ORDER BY b.created_at DESC`
  ).all(userId);
}

function usedBytes(userId = null) {
  if (userId === null) {
    const row = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM backups').get();
    return row.n;
  }
  const row = db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM backups WHERE user_id = ?').get(userId);
  return row.n;
}

// Streams the request body to a temp file while hashing it. Nothing is
// buffered in RAM beyond the stream's internal buffer (plan section 13.9).
function streamToTemp(req, tmpPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmpPath);
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('error', (err) => { failed = true; out.destroy(); reject(err); });
    out.on('error', (err) => { failed = true; reject(err); });
    req.on('end', () => out.end(() => {
      if (failed) return;
      resolve({ size, sha256: hash.digest('hex') });
    }));
    out.on('close', () => { if (failed) fs.rm(tmpPath, { force: true }, () => {}); });
  });
}

export function diskUsage() {
  return { used: usedBytes(), globalCap: Number(getSetting('backup.global_cap_bytes')) };
}

/**
 * Handles PUT /api/backups/:version/:world
 * Headers: x-sha256 (required), x-base-revision (optional, for conflict check).
 * Query: ?force=1 overwrites a newer server copy deliberately.
 */
export async function handleUpload(req, res, user, clientVersion, worldName) {
  const version = safeName(clientVersion);
  const world = safeName(worldName);
  if (!version || !world) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('invalid version or world name');
  }
  if (!req.headers['x-sha256'] || !/^[a-f0-9]{64}$/.test(req.headers['x-sha256'])) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('x-sha256 header required (lowercase hex)');
  }
  const expectedSha = req.headers['x-sha256'];
  const baseRevision = req.headers['x-base-revision'] ? Number(req.headers['x-base-revision']) : null;

  const quota = db.prepare('SELECT quota_bytes FROM users WHERE id = ?').get(user.id).quota_bytes
    ?? getSetting('backup.per_user_quota_bytes');
  const globalCap = getSetting('backup.global_cap_bytes');

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength <= 0 || contentLength > 2 * 1024 ** 3) {
    res.writeHead(413, { 'content-type': 'text/plain' });
    return res.end('missing or oversized upload (2 GB max)');
  }
  if (usedBytes() + contentLength > globalCap) {
    res.writeHead(507, { 'content-type': 'text/plain' });
    return res.end('server backup storage is full');
  }
  if (usedBytes(user.id) + contentLength > quota) {
    res.writeHead(507, { 'content-type': 'text/plain' });
    return res.end('your backup quota is full');
  }

  const existing = db.prepare(
    'SELECT * FROM backups WHERE user_id = ? AND client_version = ? AND world_name = ?'
  ).get(user.id, version, world);

  // Conflict protection (plan 13.7): refuse to silently replace a newer
  // server copy with an older local one unless the client confirms.
  if (existing && baseRevision !== null && !req.url.includes('force=1') && existing.revision > baseRevision) {
    res.writeHead(409, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      error: 'newer backup on server',
      server_revision: existing.revision,
      server_date: existing.created_at,
    }));
  }

  const dir = path.join(BACKUP_DIR, String(user.id), version);
  await fs.promises.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${world}-${Date.now()}-${process.pid}.tmp`);
  const finalPath = path.join(dir, `${world}.epk`);

  let stats;
  try {
    stats = await streamToTemp(req, tmpPath);
  } catch (err) {
    fs.rm(tmpPath, { force: true }, () => {});
    audit(user.id, 'backup_upload_failed', `${version}/${world}: ${err.message}`, clientIpOf(req));
    throw err;
  }

  if (stats.sha256 !== expectedSha) {
    fs.rm(tmpPath, { force: true }, () => {});
    audit(user.id, 'backup_upload_failed', `${version}/${world}: checksum mismatch`, clientIpOf(req));
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('checksum mismatch, upload discarded');
  }
  if (stats.size !== contentLength) {
    fs.rm(tmpPath, { force: true }, () => {});
    res.writeHead(400, { 'content-type': 'text/plain' });
    return res.end('truncated upload');
  }
  if (usedBytes(user.id) - (existing?.size_bytes ?? 0) + stats.size > quota) {
    fs.rm(tmpPath, { force: true }, () => {});
    res.writeHead(507, { 'content-type': 'text/plain' });
    return res.end('your backup quota is full');
  }

  // Atomic replace: the old backup is only touched after a fully verified
  // upload (plan 13.6). With keep_previous_copies > 1 the previous copy is
  // rotated aside first.
  const keep = Math.max(1, Number(getSetting('backup.keep_previous_copies')));
  if (keep > 1 && fs.existsSync(finalPath)) {
    for (let i = keep - 1; i >= 1; i--) {
      const from = i === 1 ? finalPath : `${finalPath}.${i - 1}`;
      const to = `${finalPath}.${i}`;
      if (fs.existsSync(from)) fs.copyFileSync(from, to);
    }
  }
  fs.renameSync(tmpPath, finalPath);
  const revision = existing ? existing.revision + 1 : 1;
  if (existing) {
    db.prepare('UPDATE backups SET revision = ?, size_bytes = ?, sha256 = ?, created_at = ? WHERE id = ?')
      .run(revision, stats.size, stats.sha256, Date.now(), existing.id);
  } else {
    db.prepare(
      'INSERT INTO backups (user_id, client_version, world_name, revision, size_bytes, sha256, visibility, path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(user.id, version, world, revision, stats.size, stats.sha256, 'private', finalPath, Date.now());
  }
  audit(user.id, 'backup_uploaded', `${version}/${world} rev ${revision} (${stats.size} bytes)`, clientIpOf(req));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, revision }));
}

function clientIpOf(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

export function canDownload(backup, user) {
  return backup.user_id === user.id || user.role === 'admin' || backup.visibility === 'shared';
}

export function getBackup(id) {
  return db.prepare('SELECT b.*, u.username AS owner FROM backups b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(id);
}
