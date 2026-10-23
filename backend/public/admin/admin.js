'use strict';
let CSRF = '';

async function jf(url, opts = {}) {
  opts.headers = { 'x-csrf-token': CSRF, ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData) && typeof opts.body !== 'string') {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('logged out'); }
  const body = await r.text();
  let data;
  try { data = body ? JSON.parse(body) : {}; } catch { data = body; }
  if (!r.ok) throw new Error(typeof data === 'object' ? (data.error || r.statusText) : body || r.statusText);
  return data;
}

const $ = (id) => document.getElementById(id);
const fmtSize = (n) => n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e3 ? (n / 1e6).toFixed(1) + ' MB' : n + ' B';
const fmtTime = (ts) => ts ? new Date(ts).toLocaleString() : '—';

// --- tabs -------------------------------------------------------------------
for (const b of document.querySelectorAll('#tabs button')) {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== 'tab-' + b.dataset.tab));
    refresh(b.dataset.tab);
  };
}
function refresh(tab) {
  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'users') loadUsers();
  else if (tab === 'backups') loadBackups();
  else if (tab === 'versions') loadVersions();
  else if (tab === 'settings') loadSettings();
  else if (tab === 'audit') loadAudit();
}

// --- dashboard --------------------------------------------------------------
async function loadDashboard() {
  const st = await jf('/api/admin/status');
  $('statusline').textContent = `disk ${st.disk_percent}% · relay ${st.relay} · turn ${st.turn} · cert ${st.cert}`;
  $('status').innerHTML = `
    <div class="grid">
      <div class="field"><span>Disk usage</span><input disabled value="${st.disk_percent}%"></div>
      <div class="field"><span>Relay</span><input disabled value="${st.relay}"></div>
      <div class="field"><span>TURN (coturn)</span><input disabled value="${st.turn}"></div>
      <div class="field"><span>TLS certificate</span><input disabled value="${st.cert}"></div>
    </div>`;
  const alerts = await jf('/api/admin/alerts');
  const tb = $('alerts');
  tb.innerHTML = '';
  for (const a of alerts.filter((a) => !a.resolved)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtTime(a.ts)}</td><td><span class="tag ${a.level}">${a.level}</span></td><td>${a.message}</td><td><a href="#" class="bad">dismiss</a></td>`;
    tr.querySelector('a').onclick = async (e) => { e.preventDefault(); await jf('/api/admin/alerts/resolve-all', { method: 'POST' }); loadDashboard(); };
    tb.appendChild(tr);
  }
  if (!alerts.some((a) => !a.resolved)) tb.innerHTML = '<tr><td colspan="4" class="dim">No open alerts.</td></tr>';
}
$('resolve-all').onclick = async () => { await jf('/api/admin/alerts/resolve-all', { method: 'POST' }); loadDashboard(); };
$('integrity').onclick = async () => {
  $('integrity-result').textContent = 'checking…';
  try {
    const r = await jf('/api/admin/integrity-check', { method: 'POST' });
    $('integrity-result').textContent = `${r.checked} checked, ${r.missing} missing, ${r.mismatched} corrupt`;
  } catch (e) { $('integrity-result').textContent = 'failed: ' + e.message; }
};

// --- users --------------------------------------------------------------------
async function loadUsers() {
  const users = await jf('/api/admin/users');
  const tb = $('users');
  tb.innerHTML = '';
  for (const u of users) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${u.username}</td><td>${u.role}</td><td>${u.quota_bytes ? fmtSize(u.quota_bytes) : 'default'}</td>
      <td>${fmtTime(u.last_login)}</td><td>${u.disabled ? 'disabled' : 'ok'}</td>`;
    const td = document.createElement('td');
    const mk = (label, fn) => { const a = document.createElement('a'); a.href = '#'; a.textContent = label; a.className = 'bad'; a.onclick = (e) => { e.preventDefault(); fn(); }; td.append(a, document.createTextNode(' · ')); };
    mk('disable', async () => { await jf('/api/admin/users/' + u.id, { method: 'PATCH', body: { disabled: !u.disabled } }); loadUsers(); });
    mk('reset pw', async () => { const p = prompt('New password (min 10 chars):'); if (p) { await jf('/api/admin/users/' + u.id, { method: 'PATCH', body: { password: p } }); alert('Password changed; their sessions were signed out.'); } });
    mk('delete', async () => { if (confirm('Delete ' + u.username + ' and sign them out? Their backups stay on disk.')) { await jf('/api/admin/users/' + u.id, { method: 'DELETE' }); loadUsers(); } });
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}
$('nu-create').onclick = async () => {
  try {
    await jf('/api/admin/users', { method: 'POST', body: { username: $('nu-name').value.trim(), password: $('nu-pass').value, role: $('nu-role').value } });
    $('nu-name').value = $('nu-pass').value = '';
    loadUsers();
  } catch (e) { alert(e.message); }
};

// --- backups -------------------------------------------------------------------
async function loadBackups() {
  const rows = await jf('/api/admin/backups');
  const tb = $('allbackups');
  tb.innerHTML = '';
  for (const b of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${b.owner}</td><td>${b.client_version}</td><td>${b.world_name}</td><td>${b.revision}</td>
      <td>${fmtSize(b.size_bytes)}</td><td>${fmtTime(b.created_at)}</td><td>${b.visibility}</td>`;
    const td = document.createElement('td');
    const mk = (label, fn) => { const a = document.createElement('a'); a.href = '#'; a.textContent = label; a.onclick = (e) => { e.preventDefault(); fn(); }; td.append(a, document.createTextNode(' · ')); };
    mk('download', () => location.href = '/api/backups/' + b.id + '/download');
    mk('share', async () => { await jf('/api/admin/backups/' + b.id, { method: 'PATCH', body: { visibility: b.visibility === 'shared' ? 'private' : 'shared' } }); loadBackups(); });
    mk('reassign', async () => { const u = prompt('Move to username:'); if (u) { try { await jf('/api/admin/backups/' + b.id, { method: 'PATCH', body: { owner_username: u } }); loadBackups(); } catch (e) { alert(e.message); } } });
    mk('delete', async () => { if (confirm('Delete this backup permanently?')) { await jf('/api/admin/backups/' + b.id, { method: 'DELETE' }); loadBackups(); } });
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  if (!rows.length) tb.innerHTML = '<tr><td colspan="8" class="dim">No backups yet.</td></tr>';
}

// --- versions --------------------------------------------------------------------
async function loadVersions() {
  const rows = await jf('/api/admin/versions');
  const tb = $('versions');
  tb.innerHTML = '';
  for (const v of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${v.name}${v.orphan ? ' <span class="dim">(folder only)</span>' : ''}</td>
      <td>${v.enabled ? 'yes' : 'no'}</td><td>${v.is_default ? 'yes' : ''}</td>
      <td class="dim">${(v.files || []).join(', ') || '—'}</td>`;
    const td = document.createElement('td');
    const mk = (label, fn) => { const a = document.createElement('a'); a.href = '#'; a.textContent = label; a.onclick = (e) => { e.preventDefault(); fn(); }; td.append(a, document.createTextNode(' · ')); };
    if (!v.orphan) {
      mk('enable/disable', async () => { await jf('/api/admin/versions/' + v.name, { method: 'PATCH', body: { enabled: !v.enabled } }); loadVersions(); });
      if (!v.is_default) mk('make default', async () => { await jf('/api/admin/versions/' + v.name, { method: 'PATCH', body: { is_default: true } }); loadVersions(); });
      mk('delete', async () => { if (confirm('Delete version ' + v.name + ' from disk?')) { await jf('/api/admin/versions/' + v.name, { method: 'DELETE' }); loadVersions(); } });
    } else {
      mk('register', async () => { await jf('/api/admin/versions/' + v.name, { method: 'PATCH', body: { enabled: true } }); loadVersions(); });
    }
    tr.appendChild(td);
    tb.appendChild(tr);
  }
}
$('nv-upload').onclick = async () => {
  const f = $('nv-file').files[0];
  if (!f) return alert('Choose a client zip first.');
  const name = $('nv-name').value.trim();
  if (!name) return alert('Give the version a name (e.g. 1.8).');
  $('nv-upload').textContent = 'Uploading…';
  try {
    await jf('/api/admin/versions/' + encodeURIComponent(name), { method: 'POST', headers: { 'content-type': 'application/zip' }, body: f });
    $('nv-file').value = '';
    loadVersions();
  } catch (e) { alert('Upload failed: ' + e.message); }
  $('nv-upload').textContent = 'Upload';
};

// --- settings ----------------------------------------------------------------------
const TEXT_FIELDS = [
  ['site.title', 'Site title'],
  ['site.tab_title', 'Browser tab title'],
  ['site.welcome_text', 'Welcome text (login page)', 'wide'],
  ['site.motd', 'Message of the day (launcher)', 'wide'],
  ['site.css', 'Custom CSS', 'wide'],
  ['site.logo_dataurl', 'Logo (data URL)', 'wide'],
  ['turn.username', 'TURN username'],
  ['turn.password', 'TURN password'],
  ['turn.public_ip', 'TURN/relay public IP (blank = VM IP)'],
  ['security.session_idle_minutes', 'Player session idle (min)'],
  ['security.session_absolute_minutes', 'Player session absolute (min)'],
  ['security.admin_idle_minutes', 'Admin session idle (min)'],
  ['security.admin_absolute_minutes', 'Admin session absolute (min)'],
  ['security.login_max_attempts', 'Login attempts before lockout'],
  ['backup.periodic_prompt_minutes', 'Backup prompt interval (min)'],
  ['backup.per_user_quota_bytes', 'Per-user backup quota (bytes)'],
  ['backup.global_cap_bytes', 'Global backup cap (bytes)'],
  ['backup.keep_previous_copies', 'Backup copies to keep'],
  ['client.allowVoiceClient', 'Voice chat enabled'],
];
let CURRENT_SETTINGS = null;
async function loadSettings() {
  CURRENT_SETTINGS = await jf('/api/admin/settings');
  const grid = $('settings');
  grid.innerHTML = '';
  for (const [key, label, cls] of TEXT_FIELDS) {
    const div = document.createElement('label');
    div.className = 'field' + (cls ? ' ' + cls : '');
    const val = CURRENT_SETTINGS[key];
    div.innerHTML = `<span>${label} <code>${key}</code></span>`;
    const input = document.createElement('input');
    input.dataset.key = key;
    input.value = val === undefined || val === null ? '' : val;
    if (typeof val === 'boolean') {
      const sel = document.createElement('select');
      sel.dataset.key = key;
      sel.innerHTML = `<option value="false"${!val ? ' selected' : ''}>off</option><option value="true"${val ? ' selected' : ''}>on</option>`;
      div.appendChild(sel);
    } else {
      div.appendChild(input);
    }
    grid.appendChild(div);
  }
  $('settings-note').textContent = '';
}
$('save-settings').onclick = async () => {
  const body = {};
  for (const el of document.querySelectorAll('#settings [data-key]')) {
    const k = el.dataset.key;
    const def = CURRENT_SETTINGS[k];
    if (el.tagName === 'SELECT') body[k] = el.value === 'true';
    else if (typeof def === 'number') body[k] = Number(el.value);
    else if (typeof def === 'boolean') body[k] = el.value === 'true';
    else body[k] = el.value;
  }
  try {
    const r = await jf('/api/admin/settings', { method: 'PUT', body });
    $('settings-note').textContent = r.network_restart_needed
      ? 'Saved. TURN/relay changed — run ./eaglerctl restart relay coturn to apply.'
      : 'Saved.';
  } catch (e) { alert('Save failed: ' + e.message); }
};

// --- audit ----------------------------------------------------------------------------
async function loadAudit() {
  const rows = await jf('/api/admin/audit/300');
  const tb = $('audit');
  tb.innerHTML = '';
  for (const a of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${fmtTime(a.ts)}</td><td>${a.username || '—'}</td><td>${a.action}</td><td class="dim">${a.detail || ''}</td><td class="dim">${a.ip || ''}</td>`;
    tb.appendChild(tr);
  }
  if (!rows.length) tb.innerHTML = '<tr><td colspan="5" class="dim">Nothing logged yet.</td></tr>';
}

// --- boot -------------------------------------------------------------------------------
$('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': CSRF } });
  location.href = '/login';
};
(async () => {
  const me = await jf('/api/me');
  CSRF = me.csrf;
  loadDashboard();
})();
