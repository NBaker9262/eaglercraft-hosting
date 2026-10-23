# Eaglercraft hosting stack

Self-hosted Eaglercraft portal for a private group of ~10 players on a small
VM (built for Oracle Always Free 1 GB Micro): login-gated game clients,
shared-world relay, TURN server, per-world server backups, and a full admin
page. Nothing to build by hand — one command brings the whole stack up.

```text
Player browser (the game runs there; the VM never renders anything)
   |  HTTPS
   v
nginx :443 ── auth_request ──> backend (accounts, sessions, backups, admin)
   |─ /            launcher (version picker + backup panel, logged in only)
   |─ /play/<v>/   client files (logged in only), index.html generated per user
   |─ /api/*       backend
   |─ /relay/      shared world relay WebSocket (logged in only)
   |─ /admin/      admin page (admin sessions only)
coturn :3478/:5349   TURN for blocked networks
```

## Deploy: one command, from Oracle Cloud Shell

No local tools needed — the whole deploy runs in Oracle's browser terminal
(full walkthrough in **[docs/vm-setup.md](docs/vm-setup.md)**):

1. In the [OCI Console](https://cloud.oracle.com/), open **Cloud Shell**
   (terminal icon in the header) and enable its **public network** option
   (Cloud Shell menu → Network settings).
2. SSH to the VM and run the one command:

```bash
ssh ubuntu@YOUR.PUBLIC.IP.HERE
git clone https://github.com/NBaker9262/eaglercraft-hosting.git
cd eaglercraft-hosting
sudo ./start.sh
```

What it does, in order: installs Docker if missing, creates `.env` from the
example (auto-detects the public IP if unset), generates the TURN password,
renders the nginx/coturn configs, builds all images, starts the stack, waits
for health, and prints the first admin password (`data/admin-credentials.txt`,
shown once — change it after logging in).

Re-running `sudo ./start.sh` is safe: it applies config changes without
losing data. Data lives in `./data` (accounts), `./backups` (world backups),
`./client` (client builds) — back those up.

## Adding the game client

The repo ships a placeholder build so everything is testable end-to-end.
Browsers don't run Minecraft by themselves: drop in a real client build from
a source you trust.

- **Easiest:** Admin page → Versions → upload the client as a zip whose root
  contains `index.html`, `classes.js`, `assets.epk`, `lang/`.
- **Or:** copy the files to `client/versions/<name>/` and run
  `sudo ./eaglerctl restart backend` (folders self-register on boot).

Enable the signature badge check in-game after installing (plan note: only
install builds from trusted sources).

## Day-2 commands

```bash
./eaglerctl status                 # container states + recent logs
./eaglerctl logs backend           # nginx | backend | relay | coturn
./eaglerctl restart relay coturn   # apply TURN/relay changes made in admin
./eaglerctl backup-db              # VACUUM the accounts db to data/eagler-backup.db
./eaglerctl admin-password <pw>    # reset the admin password from the VM
```

## Admin page

Users · landing page text, tab title, logo, CSS · client options (relays,
servers list, voice chat) · versions (upload/enable/default) · session
lifetimes and lockout policy · TURN credentials · all backups (share,
reassign, delete) · alerts (disk, certificate, relay, TURN, failed logins) ·
audit log · backup integrity check.

## Player flow

1. Log in → launcher shows the version picker and the backup panel.
2. Start a world in-game, "Start Shared World", share the join code.
3. Periodically export the world in-game as EPK and upload it on the
   launcher's backup panel. One backup per world is kept server-side, checked
   by SHA-256, replaced atomically, with a revision-conflict guard against
   overwriting a newer backup from another device.

## VM preparation (Oracle Cloud)

See **[docs/vm-setup.md](docs/vm-setup.md)**: opening Cloud Shell, the
security-list ports, the second iptables layer, zram/swap, memory caps, and
the Let's Encrypt IP-address certificate (6-day lifetime, automated renewal).

## Security model

- nginx `auth_request` gates every client file, the relay, and the API —
  client files are never publicly readable.
- Passwords hashed with bcrypt (cost 12); server-side sessions in SQLite,
  `HttpOnly; Secure` cookies, CSRF tokens on all state-changing calls.
- Login lockout with exponential backoff; admin sessions are short-lived.
- Backups stream to disk (no RAM buffering), verified by checksum, private
  by default.
- TURN credentials are visible to every logged-in user by design (the relay
  hands them to clients); rotate from the admin page when someone leaves.

## Legal

Eaglercraft is an unofficial browser port of Minecraft and is not affiliated
with Mojang or Microsoft. Host it only for a private group if you are
comfortable with its legal gray area. Players' IPs can be visible to each
other through WebRTC (inherent to peer connections and voice chat).
