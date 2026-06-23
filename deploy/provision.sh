#!/usr/bin/env bash
# One-time host provisioning for tiny VMs (e.g. Oracle free-tier ~0.5–1GB RAM):
#   - adds swap so installs don't get OOM-killed
#   - installs Node 20 from the official binary tarball (avoids dnf/apt memory use)
set -e

# 1) Swap (skip if a 2G+ swapfile already exists)
if [ ! -f /swapfile2 ]; then
  echo "==> Adding 2G swap..."
  sudo fallocate -l 2G /swapfile2 2>/dev/null || sudo dd if=/dev/zero of=/swapfile2 bs=1M count=2048
  sudo chmod 600 /swapfile2
  sudo mkswap /swapfile2
  sudo swapon /swapfile2
  grep -q '/swapfile2' /etc/fstab || echo '/swapfile2 none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# 2) Node 20 from nodejs.org binaries
if ! command -v node >/dev/null 2>&1; then
  echo "==> Installing Node.js 20 (binary tarball)..."
  ARCH=x64
  case "$(uname -m)" in aarch64|arm64) ARCH=arm64 ;; esac
  FN=$(curl -fsSL "https://nodejs.org/dist/latest-v20.x/" | grep -oE "node-v20[0-9.]+-linux-${ARCH}\.tar\.xz" | head -1)
  if [ -z "$FN" ]; then echo "Could not resolve Node download." && exit 1; fi
  curl -fsSL "https://nodejs.org/dist/latest-v20.x/$FN" -o /tmp/node.tar.xz
  sudo mkdir -p /opt/node
  sudo tar -xf /tmp/node.tar.xz -C /opt/node --strip-components=1
  sudo ln -sf /opt/node/bin/node /usr/local/bin/node
  sudo ln -sf /opt/node/bin/npm /usr/local/bin/npm
  sudo ln -sf /opt/node/bin/npx /usr/local/bin/npx
  rm -f /tmp/node.tar.xz
fi

echo "node $(node --version) / npm $(npm --version)"

# 3) Watchdog cron (restarts the bot if systemd gives up or it wedges)
WATCHDOG_SRC="$(dirname "$0")/watchdog.sh"
if [ -f "$WATCHDOG_SRC" ]; then
  echo "==> Installing raidar watchdog cron..."
  sudo cp "$WATCHDOG_SRC" /usr/local/bin/raidar-watchdog.sh
  sudo chmod +x /usr/local/bin/raidar-watchdog.sh
  # Drop any previous raidar-watchdog entry (e.g. the old */5) and install the
  # every-minute schedule so a down bot recovers within ~60s, not ~5 min.
  CRON_LINE="* * * * * /usr/local/bin/raidar-watchdog.sh >> /var/log/raidar-watchdog.log 2>&1"
  CURRENT="$(crontab -l 2>/dev/null | grep -v 'raidar-watchdog')"
  printf '%s\n%s\n' "$CURRENT" "$CRON_LINE" | grep -v '^$' | crontab -
  echo "==> Watchdog cron installed (runs every minute)."
fi
