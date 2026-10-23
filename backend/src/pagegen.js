import fs from 'node:fs';
import path from 'node:path';
import { getSetting } from './settings.js';

const CLIENT_DIR = process.env.CLIENT_DIR || '/srv/client';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function publicOrigin() {
  return `https://${process.env.PUBLIC_IP}`;
}

// The relays list sent to clients (plan 12.3): our relay behind nginx,
// unless the admin overrode `client.relays`.
export function relaysForClient() {
  const override = getSetting('client.relays');
  if (Array.isArray(override) && override.length > 0) return override;
  return [{ addr: `${publicOrigin()}/relay/`, comment: 'Home relay', primary: true }];
}

export function eaglercraftOpts(user, version) {
  return {
    container: 'game_frame',
    assetsURI: 'assets.epk',
    localesURI: 'lang/',
    worldsDB: `worlds_${user.username}_v${version.replace(/\./g, '')}`,
    relays: relaysForClient(),
    servers: getSetting('client.servers') || [],
    allowVoiceClient: Boolean(getSetting('client.allowVoiceClient')),
    demoMode: false,
  };
}

function pageShell(title, bodyHtml, extraHead = '', bodyClass = '') {
  const css = getSetting('site.css');
  const logo = getSetting('site.logo_dataurl');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/login-assets/style.css">
${logo ? `<link rel="icon" href="${logo}">` : ''}
${css ? `<style>${css}</style>` : ''}
${extraHead}
</head>
<body class="${esc(bodyClass)}">
${bodyHtml}
</body>
</html>`;
}

export function loginPage(message = '', isError = false) {
  const title = getSetting('site.title');
  const body = `
<main class="login-card">
  ${getSetting('site.logo_dataurl') ? `<img class="logo" alt="" src="${getSetting('site.logo_dataurl')}">` : ''}
  <h1>${esc(getSetting('site.title'))}</h1>
  <p class="welcome">${esc(getSetting('site.welcome_text'))}</p>
  ${message ? `<p class="msg ${isError ? 'err' : 'ok'}">${esc(message)}</p>` : ''}
  <form method="post" action="/api/login-form">
    <label>Username <input name="username" autocomplete="username" required autofocus></label>
    <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">Sign in</button>
  </form>
</main>`;
  return pageShell(`Sign in — ${title}`, body);
}

const LAUNCHER_JS = `
async function jf(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { location.href = '/login'; throw new Error('logged out'); }
  if (!r.ok) { const t = await r.text(); throw new Error(t || r.statusText); }
  return r;
}
let CSRF = '';
async function init() {
  const me = await (await jf('/api/me')).json();
  CSRF = me.csrf;
  document.getElementById('who').textContent = me.username;
  const vs = await (await jf('/api/versions')).json();
  const sel = document.getElementById('version');
  for (const v of vs) {
    const o = document.createElement('option');
    o.value = v.name; o.textContent = v.name + (v.is_default ? ' (default)' : '');
    sel.appendChild(o);
  }
  document.getElementById('play').disabled = vs.length === 0;
  renderBackups();
  setInterval(renderBackups, 5 * 60 * 1000);
}
async function renderBackups() {
  const rows = await (await jf('/api/backups')).json();
  const tb = document.getElementById('backups');
  tb.innerHTML = '';
  for (const b of rows) {
    const tr = document.createElement('tr');
    const d = new Date(b.created_at).toLocaleString();
    const size = b.size_bytes > 1e9 ? (b.size_bytes / 1e9).toFixed(2) + ' GB' : (b.size_bytes / 1e6).toFixed(1) + ' MB';
    tr.innerHTML = '<td>' + b.client_version + '</td><td>' + b.world_name + '</td><td>rev ' + b.revision + '</td><td>' + size + '</td><td>' + d + '</td>' +
      '<td><a href="/api/backups/' + b.id + '/download">download</a>' + (b.user_id === me_id() ? ' · <a href="#" class="del">delete</a>' : '') + '</td>';
    if (b.user_id === me_id()) tr.querySelector('.del').onclick = () => del(b);
    tb.appendChild(tr);
  }
  if (!rows.length) tb.innerHTML = '<tr><td colspan="6" class="dim">No server backups yet. Start a world, export it in-game as EPK, then upload it here.</td></tr>';
}
function me_id() { return window.MY_ID; }
async function upload() {
  const f = document.getElementById('file').files[0];
  if (!f) return alert('Choose the EPK file you exported in-game first.');
  const version = document.getElementById('version').value;
  let world = f.name.replace(/\\.epk$/i, '').slice(0, 64);
  world = prompt('World name for this backup:', world);
  if (!world) return;
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$/.test(world) || world.includes('..')) return alert('Invalid world name.');
  const buf = await f.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const list = await (await jf('/api/backups')).json();
  const mine = list.find(b => b.user_id === window.MY_ID && b.client_version === version && b.world_name === world);
  const url = '/api/backups/' + encodeURIComponent(version) + '/' + encodeURIComponent(world) +
    (mine ? '?base_revision=' + mine.revision : '');
  const r = await fetch(url, { method: 'PUT', headers: { 'x-sha256': sha, 'x-base-revision': String(mine ? mine.revision : 0), 'x-csrf-token': CSRF, 'content-type': 'application/octet-stream' }, body: buf });
  if (r.status === 409) {
    const info = await r.json();
    if (!confirm('The server has a NEWER backup of this world (rev ' + info.server_revision + ', ' + new Date(info.server_date).toLocaleString() + ', made from another device).\\nOverwrite it with this local copy?')) return;
    return uploadForce(version, world, buf, sha);
  }
  if (!r.ok) return alert('Upload failed: ' + await r.text());
  document.getElementById('file').value = '';
  renderBackups();
}
async function uploadForce(version, world, buf, sha) {
  const r = await fetch('/api/backups/' + encodeURIComponent(version) + '/' + encodeURIComponent(world) + '?force=1',
    { method: 'PUT', headers: { 'x-sha256': sha, 'x-csrf-token': CSRF, 'content-type': 'application/octet-stream' }, body: buf });
  if (!r.ok) return alert('Upload failed: ' + await r.text());
  renderBackups();
}
async function del(b) {
  if (!confirm('Delete the server backup of ' + b.world_name + '? Your in-game world is not touched, but the server copy will be gone.')) return;
  await jf('/api/backups/' + b.id, { method: 'DELETE', headers: { 'x-csrf-token': CSRF } });
  renderBackups();
}
document.getElementById('play').onclick = () => { location.href = '/play/' + document.getElementById('version').value + '/'; };
document.getElementById('upload').onclick = upload;
document.getElementById('logout').onclick = async () => { await fetch('/api/logout', { method: 'POST', headers: { 'x-csrf-token': CSRF } }); location.href = '/login'; };
init();
`;

export function launcherPage(user) {
  const motd = getSetting('site.motd');
  const body = `
<main class="launch">
  <header>
    <h1>${esc(getSetting('site.title'))}</h1>
    <span class="spacer"></span>
    <span id="who" class="dim"></span>
    <button id="logout" class="ghost">Sign out</button>
  </header>
  ${motd ? `<p class="motd">${esc(motd)}</p>` : ''}
  <section class="card">
    <h2>Play</h2>
    <div class="row">
      <select id="version"></select>
      <button id="play" disabled>Play</button>
    </div>
    <p class="dim">Shared worlds: start a world in-game, press "Start Shared World" and share the join code. Everyone must use the same relay (already configured).</p>
  </section>
  <section class="card">
    <h2>World backups</h2>
    <p class="dim">The server keeps <strong>one backup per world</strong>; each upload replaces the previous one.
    For worlds you care about, also save your own copy: export the world in-game as <strong>EPK</strong> or <strong>vanilla ZIP</strong>.
    (Vanilla conversion does not keep shared-play inventories or pet owners.)</p>
    <div class="row">
      <input type="file" id="file" accept=".epk,.zip">
      <button id="upload">Upload backup</button>
    </div>
    <table class="bk">
      <thead><tr><th>Version</th><th>World</th><th>Rev</th><th>Size</th><th>Saved</th><th></th></tr></thead>
      <tbody id="backups"></tbody>
    </table>
  </section>
</main>
<script>window.MY_ID = ${Number(user.id)};</script>
<script>${LAUNCHER_JS}</script>`;
  return pageShell(getSetting('site.title'), body, '', 'launch-body');
}

// Injects the per-user eaglercraftXOpts block into a client version's
// index.html (plan 12.3). The injected script must run before the client's
// own startup scripts.
export function clientIndexHtml(user, version) {
  const dir = path.join(CLIENT_DIR, version);
  const file = path.join(dir, 'index.html');
  if (!fs.existsSync(file)) return null;
  let html = fs.readFileSync(file, 'utf8');
  const opts = JSON.stringify(eaglercraftOpts(user, version), null, 2);
  const inject = `<script>window.eaglercraftXOpts = ${opts};</script>\n`;
  if (html.includes('window.eaglercraftXOpts')) {
    // The client ships its own block; replace it wholesale.
    html = html.replace(/<script>\s*window\.eaglercraftXOpts[\s\S]*?<\/script>/, inject.trim());
  } else if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${inject}`);
  } else {
    html = inject + html;
  }
  // Fixed tab title from site settings (plan section 11).
  const tabTitle = getSetting('site.tab_title');
  if (tabTitle) {
    if (/<title>[\s\S]*?<\/title>/i.test(html)) html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(tabTitle)}</title>`);
    else html = html.replace(/<head[^>]*>/i, (m) => `${m}\n<title>${esc(tabTitle)}</title>`);
  }
  return html;
}
