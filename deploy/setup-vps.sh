#!/usr/bin/env bash
# One-command setup of a Momentum game server on a fresh Ubuntu 22.04 / 24.04 VPS.
#
#   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/RayyanRS6/BallGame/main/deploy/setup-vps.sh)"
#
# Optional environment variables:
#   DOMAIN=game.example.com   use your own domain (DNS A record → this server)
#                             default: <ip-with-dashes>.sslip.io (free, works immediately)
#   SERVER_REGION=UAE         label shown in the server browser
#   REPO / BRANCH             source repository (default: this repo, main)
#
# Installs Node.js 24, Caddy (automatic HTTPS + WebSocket proxy), the game as a
# systemd service, and opens ports 80/443 in the local firewall. Re-running it
# updates the game to the latest commit.
set -euo pipefail

REPO="${REPO:-https://github.com/RayyanRS6/BallGame.git}"
BRANCH="${BRANCH:-main}"
SERVER_REGION="${SERVER_REGION:-UAE}"
APP_DIR=/opt/momentum

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (e.g. sudo bash setup-vps.sh)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

PUBLIC_IP="$(curl -fsS4 --max-time 10 https://api.ipify.org || curl -fsS4 --max-time 10 https://ifconfig.me)"
DOMAIN="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
echo "==> Public IP: ${PUBLIC_IP}   Domain: ${DOMAIN}"

# ---- Node.js 24
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
echo "==> Node $(node --version)"

# ---- Caddy (automatic Let's Encrypt certificates, WebSocket-aware reverse proxy)
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

# ---- Game
id momentum >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin momentum
# The checkout is owned by the service user; allow root to update it on re-runs.
git config --global --get-all safe.directory | grep -qx "$APP_DIR" || git config --global --add safe.directory "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
npm ci --no-audit --no-fund
npm run build
npm test

if [ ! -f .env ]; then
  cat > .env <<EOF
SERVER_PORT=8787
HOST=127.0.0.1
SERVER_NAME=Momentum ${SERVER_REGION}
SERVER_REGION=${SERVER_REGION}
TRUST_PROXY=true
LOG_FORMAT=json
EOF
fi
chown -R momentum:momentum "$APP_DIR"

cp deploy/momentum.service /etc/systemd/system/momentum.service
systemctl daemon-reload
systemctl enable momentum
systemctl restart momentum

# ---- HTTPS reverse proxy
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:8787 {
		flush_interval -1
	}
}
EOF
systemctl enable caddy
systemctl restart caddy

# ---- Local firewall (the cloud provider's firewall / security list must also allow 80 and 443)
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi
# Oracle Cloud Ubuntu images ship iptables rules that reject everything except SSH.
if iptables -S INPUT 2>/dev/null | grep -q -- "-j REJECT"; then
  for port in 80 443; do
    iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && netfilter-persistent save || true
fi

echo "==> Waiting for the certificate…"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://${DOMAIN}/api/info" >/dev/null 2>&1; then break; fi
  sleep 2
done

if curl -fsS --max-time 5 "https://${DOMAIN}/api/info"; then
  echo
  echo "=================================================================="
  echo " Momentum server is live:  https://${DOMAIN}"
  echo " Play directly there, or set this in Vercel → Environment Variables:"
  echo "   VITE_SERVERS=https://${DOMAIN}"
  echo " Logs:    journalctl -u momentum -f"
  echo " Update:  re-run this script"
  echo "=================================================================="
else
  echo
  echo "The game runs locally (curl http://127.0.0.1:8787/api/info) but HTTPS is not reachable yet."
  echo "Check that your cloud firewall / security group allows inbound TCP 80 and 443,"
  echo "then run: systemctl restart caddy && journalctl -u caddy -n 50"
  exit 1
fi
