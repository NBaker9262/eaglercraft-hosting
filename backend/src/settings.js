import db from './db.js';

// All defaults from the hosting plan (sections 10, 11, 13).
export const DEFAULTS = {
  'site.title': 'Eaglercraft',
  'site.tab_title': 'Eaglercraft',
  'site.welcome_text': 'Welcome to the private server. Ask the admin for an account.',
  'site.motd': '',
  'site.css': '',
  'site.logo_dataurl': '',

  'client.allowVoiceClient': false,
  'client.servers': [],
  // relays are generated from the TURN/relay config on render; the list
  // here is an override. Empty = use the generated wss://<ip>/relay/.
  'client.relays': [],

  'security.session_idle_minutes': 720,       // 12 h for players
  'security.session_absolute_minutes': 10080, // 7 d
  'security.admin_idle_minutes': 30,          // 30 min for admin
  'security.admin_absolute_minutes': 480,     // 8 h
  'security.login_max_attempts': 5,
  'security.lockout_base_seconds': 30,        // doubles per lockout, capped 1 h
  'security.admin_ip_allowlist': [],

  'backup.periodic_prompt_minutes': 20,
  'backup.per_user_quota_bytes': 3 * 1024 ** 3,     // 3 GB
  'backup.global_cap_bytes': 32 * 1024 ** 3,        // 32 GB
  'backup.keep_previous_copies': 1,

  'turn.username': 'eagler',
  'turn.password': '',
  'turn.public_ip': '',

  'alert.disk_percent': 80,
  'alert.cert_warn_hours': 48,
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) {
    try { return JSON.parse(row.value); } catch { return row.value; }
  }
  return DEFAULTS[key];
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

export function allSettings() {
  const out = { ...DEFAULTS };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}
