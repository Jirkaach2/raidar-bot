#!/usr/bin/env bash
# Raidar bot watchdog — run every 5 minutes via cron.
# Detects systemd "failed" state and force-restarts the bot.
#
# Install (done automatically by provision.sh):
#   sudo cp /home/opc/raidar-bot/deploy/watchdog.sh /usr/local/bin/raidar-watchdog.sh
#   sudo chmod +x /usr/local/bin/raidar-watchdog.sh
#   (crontab -l 2>/dev/null; echo "*/5 * * * * /usr/local/bin/raidar-watchdog.sh >> /var/log/raidar-watchdog.log 2>&1") | crontab -

SERVICE="raidar-bot"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog]"

is_active() {
  systemctl is-active --quiet "$SERVICE"
}

is_failed() {
  [ "$(systemctl is-failed "$SERVICE")" = "failed" ]
}

# --- Check 1: systemd says "failed" (crash-loop limit hit) -----------------
if is_failed; then
  echo "$LOG_PREFIX Service is in FAILED state — resetting and restarting..."
  sudo systemctl reset-failed "$SERVICE"
  sudo systemctl start "$SERVICE"
  sleep 5
  if is_active; then
    echo "$LOG_PREFIX Restart succeeded. Service is now active."
  else
    echo "$LOG_PREFIX Restart FAILED. Check: journalctl -u $SERVICE -n 50"
  fi
  exit 0
fi

# --- Check 2: service is simply not running --------------------------------
if ! is_active; then
  echo "$LOG_PREFIX Service is inactive — starting..."
  sudo systemctl start "$SERVICE"
  sleep 5
  if is_active; then
    echo "$LOG_PREFIX Start succeeded. Service is now active."
  else
    echo "$LOG_PREFIX Start FAILED. Check: journalctl -u $SERVICE -n 50"
  fi
  exit 0
fi

# --- All good ---------------------------------------------------------------
echo "$LOG_PREFIX Service is healthy."
