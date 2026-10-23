# VM preparation (Oracle Cloud, Ubuntu)

Do this once, before (or right after) running `sudo ./start.sh`.

## 1. Oracle Cloud console

1. **Reserve a static IP** — Networking → Reserved public IPs, attach it to
   the instance. Put it in `.env` as `PUBLIC_IP`.
2. **Security list / NSG ingress rules** (source `0.0.0.0/0` unless you know
   the players' ranges):

   | Protocol | Port          | Purpose                    |
   |----------|---------------|----------------------------|
   | TCP      | 22            | SSH (restrict to your IP)  |
   | TCP      | 80            | ACME validation + redirect |
   | TCP      | 443           | HTTPS site + relay         |
   | TCP+UDP  | 3478          | TURN                       |
   | TCP      | 5349          | TURN over TLS              |
   | UDP      | 49160–49200   | TURN relay range           |

## 2. Ubuntu iptables (the second firewall layer)

Oracle Ubuntu images ship restrictive iptables rules that the security list
does not override. Insert ACCEPT rules **before** any REJECT rule:

```bash
sudo iptables -L INPUT -n --line-numbers   # check positions first

sudo iptables -I INPUT 5 -p tcp --dport 80   -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 443  -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 3478 -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 5 -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 5349 -m conntrack --ctstate NEW -j ACCEPT
sudo iptables -I INPUT 5 -p udp --dport 49160:49200 -j ACCEPT

sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

## 3. Base system

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl git unattended-upgrades

# SSH key-only login
#   /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no
sudo systemctl restart ssh
```

## 4. Memory safety (1 GB VM)

```bash
# zram: ~512 MB compressed swap in RAM
sudo apt install -y zram-tools
echo 'ALGO=zstd
PERCENT=50' | sudo tee /etc/default/zramswap
sudo systemctl restart zramswap

# small disk swap as a last resort
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw,pri=1 0 0' | sudo tee -a /etc/fstab
echo 'vm.swappiness=60' | sudo tee /etc/sysctl.d/99-swap.conf
sudo sysctl --system
```

Per-service memory caps are already set in `docker-compose.yml`
(`mem_limit`): nginx 64 MB, backend 160 MB, relay 150 MB, coturn 80 MB.

## 5. HTTPS: Let's Encrypt IP address certificate

IP certificates are valid ~6 days (160 h), so renewal must be automated.
Validation is HTTP-01 only, which is why port 80 stays open.

```bash
sudo apt install -y certbot

# Issue the first certificate (standalone needs nginx stopped once:
# sudo docker compose stop nginx first, or use the webroot method below
# once start.sh has run and rendered/acme is being served).
sudo certbot certonly --standalone \
  --preferred-profile shortlived \
  --ip-address YOUR.PUBLIC.IP.HERE

# Copy into the stack and enable TLS
sudo mkdir -p tls/nginx
sudo cp /etc/letsencrypt/live/YOUR.PUBLIC.IP.HERE/fullchain.pem tls/nginx/
sudo cp /etc/letsencrypt/live/YOUR.PUBLIC.IP.HERE/privkey.pem  tls/nginx/
sudo ./start.sh        # re-render: nginx now serves HTTPS
```

### Automated renewal (twice daily — 6-day certificates leave little slack)

```bash
sudo tee /etc/cron.d/eagler-certbot >/dev/null <<'EOF'
17 3,15 * * * root certbot renew --quiet --deploy-hook "/bin/sh -c 'cp /etc/letsencrypt/live/*/fullchain.pem /path/to/repo/tls/nginx/fullchain.pem; cp /etc/letsencrypt/live/*/privkey.pem /path/to/repo/tls/nginx/privkey.pem; cd /path/to/repo && ./eaglerctl restart nginx coturn'" 2>/dev/null
EOF
```

(Replace `/path/to/repo` with the checkout path.) The backend reads
`tls/nginx/fullchain.pem` daily and raises an admin alert when under 48 h
remain, so a missed renewal is visible on the admin page.

## 6. Feasibility test before inviting everyone

With the stack up and a real client installed (plan section 15):

- T1: host starts a shared world on the **controlled Wi-Fi**, guest joins.
- T2: remove the TURN entries (admin page → TURN password blank +
  `./eaglerctl restart relay`), test again — direct P2P?
- T3–T5: TURN over UDP 3478 / TCP / TLS 5349, one at a time.
- T7: several guests joined — watch VM load (`htop`, `docker stats`).
- T8: from each player's network, which outbound ports work?

Decision matrix (plan section 15.4): direct P2P everywhere → TURN stays as a
spare. TURN needed and load acceptable → keep it. TURN blocked or load too
heavy → consider Plan B (a real EaglerXServer behind nginx on 443), which
was deliberately left out of this stack until the test says otherwise.

## 7. Where things live

| Path          | Contents                                |
|---------------|-----------------------------------------|
| `data/`       | SQLite database, relay config, admin credentials |
| `backups/`    | World backups (`<user>/<version>/<world>.epk`) |
| `client/`     | Client builds per version               |
| `rendered/`   | Generated nginx/coturn configs (do not edit by hand) |
| `tls/`        | TLS certificates                        |
