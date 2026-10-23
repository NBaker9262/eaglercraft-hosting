#!/usr/bin/env bash
# Eaglercraft hosting stack — the one command.
#
#   sudo ./start.sh
#
# Extract this repo on the VM, edit PUBLIC_IP in .env (created from the
# example on first run), and run the line above. Everything is built and
# started: nginx + backend + shared world relay + coturn. Re-running it is
# safe and applies any config changes.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo ./start.sh"; exit 1; }

# --- Docker -------------------------------------------------------------------
if ! command -v docker >/dev/null; then
  echo "== Installing Docker (get.docker.com) =="
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "== Installing the Docker Compose plugin =="
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# --- .env ----------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  echo "== Created .env from .env.example =="
fi
# shellcheck disable=SC1091
source .env

# The VM's private IP, used for coturn's external-ip mapping (Oracle NAT).
if [ -z "${PRIVATE_IP:-}" ]; then
  PRIV=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
  [ -n "$PRIV" ] && echo "PRIVATE_IP=$PRIV" >> .env
fi

if [ -z "${PUBLIC_IP:-}" ] || [ "${PUBLIC_IP}" = "203.0.113.10" ]; then
  DETECTED=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
  [ -n "$DETECTED" ] && { sed -i "s/^PUBLIC_IP=.*/PUBLIC_IP=$DETECTED/" .env; PUBLIC_IP=$DETECTED;
    echo "== Detected public IP: $DETECTED (check it in .env!) =="; }
fi
if [ -z "${PUBLIC_IP:-}" ]; then
  echo "Set PUBLIC_IP in .env (the VM's static public IP) and run again."; exit 1
fi
if [ -z "${TURN_PASSWORD:-}" ]; then
  TURN_PASSWORD=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  if grep -q '^TURN_PASSWORD=' .env; then sed -i "s/^TURN_PASSWORD=.*/TURN_PASSWORD=$TURN_PASSWORD/" .env
  else echo "TURN_PASSWORD=$TURN_PASSWORD" >> .env; fi
  echo "== Generated TURN password =="
fi
source .env
export PUBLIC_IP TURN_PASSWORD

# --- Rendered configuration ------------------------------------------------------
mkdir -p rendered/nginx rendered/coturn rendered/acme data/relay tls/nginx client/versions
touch rendered/coturn/turnserver.conf

export TLS_ON=0
if [ -f tls/nginx/fullchain.pem ] && [ -f tls/nginx/privkey.pem ]; then
  TLS_ON=1
  cat > rendered/nginx/tls.conf <<EOF
listen 443 ssl default_server;
http2 on;
ssl_certificate     /etc/nginx/tls/fullchain.pem;
ssl_certificate_key /etc/nginx/tls/privkey.pem;
ssl_protocols TLSv1.2 TLSv1.3;
EOF
else
  cat > rendered/nginx/tls.conf <<'EOF'
listen 443 default_server;
EOF
  echo "== No TLS certificate yet: serving plain HTTP. See docs/vm-setup.md for the"
  echo "   Let's Encrypt IP certificate, then re-run ./start.sh =="
fi

sed "s/__PUBLIC_IP__/${PUBLIC_IP}/g" nginx/eagler.conf.template > rendered/nginx/eagler.conf

# Security headers (plan section 18). The Eaglercraft client needs
# wasm + eval + blob workers, so the CSP stays permissive on purpose.
cat > rendered/nginx/security.conf <<'EOF'
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy strict-origin-when-cross-origin always;
add_header X-Frame-Options SAMEORIGIN always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'" always;
EOF

# Placeholder client build so the flow is testable end-to-end before the
# real client zip is uploaded on the admin page.
if [ ! -f client/versions/1.8/index.html ]; then
  mkdir -p client/versions/1.8
  cat > client/versions/1.8/index.html <<'EOF'
<!DOCTYPE html>
<html><head><title>Client placeholder</title></head>
<body style="background:#16161d;color:#e8e8ee;font-family:sans-serif;text-align:center;padding-top:15vh">
<h1>Client files for this version are not installed</h1>
<p>This is a placeholder. The admin can upload the real client zip on the admin page
(Admin → Versions) and it will replace this folder's entry.</p>
</body></html>
EOF
fi

# --- Build and start --------------------------------------------------------------
echo "== Building images (first run takes a few minutes) =="
docker compose build

echo "== Starting stack =="
docker compose up -d
# Bind-mounted configs (nginx, coturn, relay) are read at container start;
# recreate so a re-run applies re-rendered configs, not just the first boot.
docker compose up -d --force-recreate --no-deps backend relay coturn nginx >/dev/null 2>&1 || true

echo "== Waiting for the backend =="
for i in $(seq 1 60); do
  if docker compose exec -T backend wget -q -O /dev/null http://127.0.0.1:3000/healthz 2>/dev/null; then break; fi
  sleep 1
  [ "$i" = 60 ] && { echo "Backend did not come up; check: docker compose logs"; exit 1; }
done

echo
echo "============================================================"
echo " Eaglercraft stack is up."
if [ "$TLS_ON" = 1 ]; then
  echo " Site:   https://$PUBLIC_IP/"
else
  echo " Site:   http://$PUBLIC_IP/   (HTTPS once a certificate exists)"
fi
echo " Admin:  http://$PUBLIC_IP/admin"
if [ -f data/admin-credentials.txt ]; then
  echo " First admin login:  $(head -1 data/admin-credentials.txt)"
  echo " (shown once — change the password after logging in)"
fi
echo " Commands: ./eaglerctl status | logs <service> | restart <service>"
echo "============================================================"
