#!/usr/bin/env bash
# Installs Caddy as an auto-HTTPS reverse proxy in front of the bot (:3000).
# Run on the VM from the bot dir:  bash deploy/setup-caddy.sh
set -e

# 1) Caddy static binary (low memory; avoids dnf)
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Downloading Caddy..."
  ARCH=amd64; case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; esac
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${ARCH}" -o /tmp/caddy
  sudo install -m 0755 /tmp/caddy /usr/local/bin/caddy
  rm -f /tmp/caddy
fi
caddy version

# 2) Config + service
sudo mkdir -p /etc/caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo cp deploy/caddy.service /etc/systemd/system/caddy.service

# 3) Open 80 + 443 in the host firewall (OCI security list still needs ingress rules!)
if command -v firewall-cmd >/dev/null 2>&1 && sudo systemctl is-active --quiet firewalld; then
  sudo firewall-cmd --permanent --add-service=http
  sudo firewall-cmd --permanent --add-service=https
  sudo firewall-cmd --reload
fi

# 4) Start
sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 4
sudo systemctl --no-pager status caddy | head -n 12
