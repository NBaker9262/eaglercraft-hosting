# VM preparation (Oracle Cloud, Ubuntu) — done from Cloud Shell

Everything in this guide runs in **Oracle Cloud Shell** — the browser terminal
built into the OCI Console. You don't need a local terminal, local SSH keys,
or any local tools: Cloud Shell ships with Git, SSH, Docker, and a
pre-authenticated OCI CLI, and keeps 5 GB of home storage between sessions.

Reference: [Oracle Cloud Shell documentation](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/cloudshellintro.htm).

## 0. Open Cloud Shell and reach the VM

1. Log in to the [OCI Console](https://cloud.oracle.com/).
2. Click the **Cloud Shell / Code Editor icon** in the Console header and
   choose **Cloud Shell**.
3. Cloud Shell's network access is restricted to OCI-internal addresses by
   default. Open the **gear (Network settings) menu** in the Cloud Shell
   window and enable the **public network**, so it can reach your VM's public
   IP and `github.com`.
4. SSH to the VM (this is where every later step runs):

```bash
ssh ubuntu@129.146.247.75
```

If you don't have a key yet, generate one in Cloud Shell and add it to the
instance (Instance details → **Edit** → SSH keys, or at instance creation):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub   # paste this into the instance's SSH keys
```

## 1. Networking: public IP, VCN, and firewall rules — all from Cloud Shell

These are plain `oci` CLI commands. Cloud Shell's CLI is already
authenticated to your tenancy — run `oci whoami` to confirm; no keys, no
`oci login`. References:
[CLI command reference](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/),
[assigning a reserved public IP](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/reserved-public-ip-assign.htm),
[updating security list rules](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/update-securitylist.htm).

Set the compartment to work in first (copy its OCID from the output of
`oci iam compartment list`, or use the tenancy OCID from `oci whoami` to
work in the root compartment):

```bash
C=ocid1.compartment.oc1..PASTE_YOUR_COMPARTMENT_OCID
```

### 1a. Find the VM, its VNIC, and its VCN

```bash
# Pick your eagler VM's OCID from this table
oci compute instance list --compartment-id "$C" \
  | jq -r '.data[] | select(."lifecycle-state"!="TERMINATED")
           | [."display-name", .id] | @tsv'
I=ocid1.instance.oc1..PASTE_INSTANCE_OCID

# Primary VNIC and its primary private IP
VNIC=$(oci compute vnic-attachment list --compartment-id "$C" --instance-id "$I" \
  | jq -r '.data[0]."vnic-id"')
PRIVIP=$(oci network private-ip list --vnic-id "$VNIC" \
  | jq -r '.data[] | select(."is-primary") | .id')

# Subnet + VCN + security list the VM uses (first subnet in the compartment;
# if you have several, pick the row whose vcn-id matches the VM)
oci network subnet list --compartment-id "$C" \
  | jq -r '.data[] | [."display-name", .id, ."vcn-id"] | @tsv'
SUBNET=ocid1.subnet.oc1..PASTE_SUBNET_OCID
VCN=$(oci network subnet get --subnet-id "$SUBNET" | jq -r '.data."vcn-id"')
SL=$(oci network subnet get --subnet-id "$SUBNET" \
  | jq -r '.data."security-list-ids"[0]')
```

### 1b. Assign the reserved public IP `129.146.247.75`

The IP `129.146.247.75` is already reserved. Confirm it and check whether
it is attached:

```bash
oci network public-ip list --compartment-id "$C" \
  | jq -r '.data[] | select(."ip-address"=="129.146.247.75")
           | [.id, ."lifecycle-state", (."private-ip-id" // "unassigned")] | @tsv'
PIP=ocid1.publicip.oc1..PASTE_PUBLICIP_OCID
```

Attach it to the VM's primary private IP — this is the step that makes
`129.146.247.75` the VM's address:

```bash
oci network public-ip update --public-ip-id "$PIP" --private-ip-id "$PRIVIP" \
  --wait-for-state ASSIGNED
```

If this fails because the VM still holds an **ephemeral** public IP, delete
that one first (a private IP can only have one public IP), then re-run the
`update` above:

```bash
EPH=$(oci network public-ip list --compartment-id "$C" \
  | jq -r --arg p "$PRIVIP" '.data[]
      | select(."private-ip-id"==$p and ."lifetime"=="EPHEMERAL") | .id')
[ -n "$EPH" ] && oci network public-ip delete --public-ip-id "$EPH" --force
```

(If you ever need to reserve another IP: `oci network public-ip create
--compartment-id "$C" --lifetime RESERVED --display-name eagler-ip`.)

### 1c. Open the ports in the security list

Source `0.0.0.0/0` unless you know the players' IP ranges:

| Protocol | Port        | Purpose                    |
|----------|-------------|----------------------------|
| TCP      | 22          | SSH (restrict to your IP)  |
| TCP      | 80          | ACME validation + redirect |
| TCP      | 443         | HTTPS site + relay         |
| TCP+UDP  | 3478        | TURN                       |
| TCP      | 5349        | TURN over TLS              |
| UDP      | 49160–49200 | TURN relay range           |

`oci network security-list update` **replaces the entire existing rule set**,
so fetch the current rules and send old + new together (Cloud Shell has
`jq` preinstalled):

```bash
# Rules to add
cat > /tmp/eagler-ingress.json <<'EOF'
[
  {"protocol":"tcp","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
  {"protocol":"tcp","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
  {"protocol":"tcp","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":3478,"max":3478}}},
  {"protocol":"udp","source":"0.0.0.0/0","udpOptions":{"destinationPortRange":{"min":3478,"max":3478}}},
  {"protocol":"tcp","source":"0.0.0.0/0","tcpOptions":{"destinationPortRange":{"min":5349,"max":5349}}},
  {"protocol":"udp","source":"0.0.0.0/0","udpOptions":{"destinationPortRange":{"min":49160,"max":49200}}}
]
EOF

# Existing rules + the new ones, as one full replacement
oci network security-list update --security-list-id "$SL" \
  --ingress-security-rules "$(oci network security-list get --security-list-id "$SL" \
      | jq -c --slurpfile new /tmp/eagler-ingress.json \
      '.data."ingress-security-rules" + $new[0]')"

# Verify: every port above should appear in the output
oci network security-list get --security-list-id "$SL" \
  | jq -r '.data."ingress-security-rules"[] | [.protocol, .source, (.tcpOptions.destinationPortRange.min // .udpOptions.destinationPortRange.min // "")] | @tsv'
```

### 1d. Only if you need a brand-new VCN and subnet

The Console's "VCN with Internet Connectivity" wizard, or these commands:

```bash
VCN=$(oci network vcn create --compartment-id "$C" --display-name eagler-vcn \
  --cidr-blocks '["10.0.0.0/16"]' | jq -r '.data.id')

# Internet gateway + default route, so the subnet can reach the internet
IGW=$(oci network internet-gateway create --compartment-id "$C" \
  --vcn-id "$VCN" --display-name eagler-igw --is-enabled true | jq -r '.data.id')
RT=$(oci network vcn get --vcn-id "$VCN" | jq -r '.data."default-route-table-id"')
oci network route-table update --rt-id "$RT" \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"network-entity-id\":\"$IGW\"}]"

SUBNET=$(oci network subnet create --compartment-id "$C" --vcn-id "$VCN" \
  --display-name eagler-subnet --cidr-block 10.0.0.0/24 | jq -r '.data.id')
SL=$(oci network subnet get --subnet-id "$SUBNET" \
  | jq -r '.data."security-list-ids"[0]')
# then apply the security-list update from 1c to this SL
```

### 1e. Ubuntu iptables (second firewall layer — cannot be done via `oci` CLI)

Oracle Ubuntu images ship restrictive host rules the security list does not
override. Still in the SSH session on the VM, insert ACCEPT rules **before**
any REJECT rule:

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

## 2. Base system and memory safety (on the VM)

```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y curl git unattended-upgrades

# SSH key-only login
#   /etc/ssh/sshd_config: PasswordAuthentication no, PermitRootLogin no
sudo systemctl restart ssh

# zram: ~512 MB compressed swap in RAM
sudo apt install -y zram-tools
printf 'ALGO=zstd\nPERCENT=50\n' | sudo tee /etc/default/zramswap
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

## 3. Deploy — the one command

Still in the SSH session on the VM:

```bash
git clone https://github.com/NBaker9262/eaglercraft-hosting.git
cd eaglercraft-hosting
sudo ./start.sh
```

The repo is private, so Git asks for your GitHub username and a
**personal access token** (fine-grained, read-only Contents access is
enough). Create one at github.com → Settings → Developer settings.

`start.sh` installs Docker if missing, creates `.env` (auto-detects the
public IP, generates the TURN password), renders the nginx/coturn configs,
builds all images, starts the stack, waits for health, and prints the first
admin password (`data/admin-credentials.txt`, shown once — change it after
logging in).

## 4. HTTPS: Let's Encrypt IP address certificate

IP certificates are valid ~6 days (160 h), so renewal must be automated.
Validation is HTTP-01 only, which is why port 80 stays open.

On the VM:

```bash
sudo apt install -y certbot

# Issue the first certificate (standalone needs nginx stopped once):
sudo docker compose stop nginx
sudo certbot certonly --standalone \
  --preferred-profile shortlived \
  --ip-address 129.146.247.75
sudo docker compose start nginx

# Copy into the stack and enable TLS
sudo mkdir -p tls/nginx
sudo cp /etc/letsencrypt/live/129.146.247.75/fullchain.pem tls/nginx/
sudo cp /etc/letsencrypt/live/129.146.247.75/privkey.pem  tls/nginx/
sudo ./start.sh          # re-renders: nginx now serves HTTPS
```

### Automated renewal (twice daily — 6-day certificates leave little slack)

```bash
sudo tee /etc/cron.d/eagler-certbot >/dev/null <<'EOF'
17 3,15 * * * root certbot renew --quiet --deploy-hook "/bin/sh -c 'cp /etc/letsencrypt/live/*/fullchain.pem /opt/eaglercraft-hosting/tls/nginx/fullchain.pem; cp /etc/letsencrypt/live/*/privkey.pem /opt/eaglercraft-hosting/tls/nginx/privkey.pem; cd /opt/eaglercraft-hosting && ./eaglerctl restart nginx coturn'" 2>/dev/null
EOF
```

(Clone to `/opt/eaglercraft-hosting` to match the path above, or adjust it.)
The backend reads `tls/nginx/fullchain.pem` daily and raises an admin alert
when under 48 h remain, so a missed renewal is visible on the admin page.

## 5. Day-2 operations (from Cloud Shell)

Cloud Shell sessions time out after ~20 minutes idle — that's fine: the
stack keeps running on the VM regardless. Reconnect and use:

```bash
cd eaglercraft-hosting
./eaglerctl status                 # container states + recent logs
./eaglerctl logs backend           # nginx | backend | relay | coturn
./eaglerctl restart relay coturn   # apply TURN/relay changes made in admin
./eaglerctl backup-db              # VACUUM the accounts db to data/eagler-backup.db
./eaglerctl admin-password <pw>    # reset the admin password from the VM
```

To keep the clone persistent between Cloud Shell sessions, clone it on the
**VM** (as above), not in Cloud Shell's home directory — Cloud Shell only
provides 5 GB and is for running commands, while all state lives on the VM
under the repo directory.

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

## 7. Where things live (on the VM)

| Path        | Contents                                        |
|-------------|-------------------------------------------------|
| `data/`     | SQLite database, relay config, admin credentials |
| `backups/`  | World backups (`<user>/<version>/<world>.epk`)   |
| `client/`   | Client builds per version                        |
| `rendered/` | Generated nginx/coturn configs (do not edit)     |
| `tls/`      | TLS certificates                                 |
