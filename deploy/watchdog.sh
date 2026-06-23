#!/usr/bin/env bash
# Raidar bot watchdog — run every minute via cron.
# Detects systemd "failed"/inactive state AND a wedged HTTP server (process
# alive but /health not responding) and force-restarts the bot.
#
# Install (done automatically by provision.sh):
#   sudo cp /home/opc/raidar-bot/deploy/watchdog.sh /usr/local/bin/raidar-watchdog.sh
#   sudo chmod +x /usr/local/bin/raidar-watchdog.sh
#   (crontab -l 2>/dev/null; echo "* * * * * /usr/local/bin/raidar-watchdog.sh >> /home/opc/raidar-watchdog.log 2>&1") | crontab -

SERVICE="raidar-bot"
HEALTH_PORT="${PAIRING_PORT:-3000}"
LOG_PREFIX="[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog]"

is_active() {
  systemctl is-active --quiet "$SERVICE"
}

is_failed() {
  [ "$(systemctl is-failed "$SERVICE")" = "failed" ]
}

restart() {
  sudo systemctl reset-failed "$SERVICE" 2>/dev/null
  sudo systemctl restart "$SERVICE"
  sleep 5
  if is_active; then echo "$LOG_PREFIX Restart succeeded."; else echo "$LOG_PREFIX Restart FAILED. Check: journalctl -u $SERVICE -n 50"; fi
}

# --- Check 1: systemd says "failed" (crash-loop limit hit) -----------------
if is_failed; then
  echo "$LOG_PREFIX Service is in FAILED state — resetting and restarting..."
  restart
  exit 0
fi

# --- Check 2: service is simply not running --------------------------------
if ! is_active; then
  echo "$LOG_PREFIX Service is inactive — starting..."
  sudo systemctl start "$SERVICE"
  sleep 5
  if is_active; then echo "$LOG_PREFIX Start succeeded."; else echo "$LOG_PREFIX Start FAILED. Check: journalctl -u $SERVICE -n 50"; fi
  exit 0
fi

# --- Check 3: process is "active" but the HTTP server is wedged ------------
# Two quick attempts (allow a transient blip) before declaring it stuck.
if ! curl -fsS --max-time 8 "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then
  sleep 3
  if ! curl -fsS --max-time 8 "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then
    echo "$LOG_PREFIX Health check FAILED on :${HEALTH_PORT} while service is active — restarting (wedged)..."
    restart
    exit 0
  fi
fi

# --- All good ---------------------------------------------------------------
echo "$LOG_PREFIX Service is healthy."
