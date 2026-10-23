import dgram from 'node:dgram';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import db from './db.js';
import { getSetting } from './settings.js';

const BACKUP_DIR = process.env.BACKUP_DIR || '/srv/backups';
const TLS_DIR = process.env.TLS_DIR || '/tls';
const RELAY_URL = process.env.RELAY_HEALTH_URL || 'http://relay:8081/health';
const COTURN_HOST = process.env.COTURN_HOST || 'host.docker.internal';

const state = { lastDisk: null, lastCert: null, lastRelay: null, lastTurn: null };

export function raiseAlert(level, key, message) {

  const row = db.prepare('SELECT id, message, resolved FROM alerts WHERE key = ?').get(key);
  if (row && row.message === message && !row.resolved) return;
  db.prepare(
    'INSERT INTO alerts (ts, level, key, message) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET ts = excluded.ts, level = excluded.level, message = excluded.message, resolved = 0'
  ).run(Date.now(), level, key, message);
}

function clear(key) {
  db.prepare('DELETE FROM alerts WHERE key = ?').run(key);
}

function checkDisk() {
  try {
    const s = fs.statfsSync(BACKUP_DIR);
    const percent = Math.round((1 - s.bfree / s.blocks) * 100);
    state.lastDisk = percent;
    const warn = Number(getSetting('alert.disk_percent'));
    if (percent >= 90) raiseAlert('critical', 'disk', `Disk usage ${percent}% (critical)`);
    else if (percent >= warn) raiseAlert('warning', 'disk', `Disk usage ${percent}%`);
    else clear('disk');
  } catch (err) {
    state.lastDisk = `error: ${err.message}`;
  }
}

function checkCert() {
  const file = path.join(TLS_DIR, 'nginx', 'fullchain.pem');
  if (!fs.existsSync(file)) {
    state.lastCert = 'no certificate installed';
    raiseAlert('info', 'cert', 'No TLS certificate installed — the site is served over plain HTTP until certbot issues one.');
    return;
  }
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(file));
    const expires = new Date(cert.validTo).getTime();
    const hoursLeft = (expires - Date.now()) / 3600_000;
    state.lastCert = `valid until ${cert.validTo}`;
    if (hoursLeft < Number(getSetting('alert.cert_warn_hours'))) {
      raiseAlert('warning', 'cert', `TLS certificate expires in ${Math.max(0, Math.round(hoursLeft))} h — check the renewal timer.`);
    } else clear('cert');
  } catch (err) {
    state.lastCert = `unreadable: ${err.message}`;
    raiseAlert('warning', 'cert', 'TLS certificate could not be read.');
  }
}

async function checkRelay() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(RELAY_URL, { signal: ctrl.signal });
    clearTimeout(t);
    state.lastRelay = r.ok ? 'running' : `HTTP ${r.status}`;
    if (!r.ok) raiseAlert('critical', 'relay', `Relay responded with HTTP ${r.status}`);
    else clear('relay');
  } catch {
    state.lastRelay = 'unreachable';
    raiseAlert('critical', 'relay', 'Shared world relay is not responding.');
  }
}

// A minimal STUN binding request; a real response proves coturn's UDP
// listener is alive on this host.
function stunProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const tid = crypto.randomBytes(12);
    // Binding request: type 0x0001, length 0, magic cookie, transaction id
    const msg = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), tid]);
    const done = (ok) => { try { sock.close(); } catch {} resolve(ok); };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.on('message', (m) => {
      if (m.length >= 20 && m.readUInt16BE(0) === 0x0101 && m.subarray(4, 16).equals(tid)) {
        clearTimeout(timer);
        done(true);
      }
    });
    sock.on('error', () => { clearTimeout(timer); done(false); });
    sock.send(msg, port, host);
  });
}

async function checkTurn() {
  const ok = await stunProbe(COTURN_HOST, 3478);
  state.lastTurn = ok ? 'running' : 'no response';
  if (ok) clear('turn');
  else raiseAlert('critical', 'turn', 'coturn is not responding on UDP 3478.');
}

function checkFailedLogins() {
  const since = Date.now() - 3600_000;
  const row = db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ok = 0 AND ts > ?').get(since);
  if (row.n >= 20) raiseAlert('warning', 'logins', `${row.n} failed logins in the last hour.`);
  else clear('logins');
}

let timer = null;
export function startAlertLoop() {
  const run = () => {
    try {
      checkDisk();
      checkCert();
      checkFailedLogins();
      checkRelay().then(checkTurn).catch(() => {});
    } catch (err) {
      console.error('alert loop error:', err);
    }
  };
  run();
  timer = setInterval(run, 60_000);
  return timer;
}

export function statusSnapshot() {
  const s = fs.statfsSync(BACKUP_DIR);
  return {
    disk_percent: Math.round((1 - s.bfree / s.blocks) * 100),
    cert: state.lastCert,
    relay: state.lastRelay,
    turn: state.lastTurn,
  };
}
