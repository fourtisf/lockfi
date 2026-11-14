#!/usr/bin/env bash
#
# Is the indexer actually indexing?
#
# Run from cron every five minutes:
#   */5 * * * * /var/www/balast/deploy/monitor.sh
#
# §8's P3 criterion names the failure this exists for: "a keeper that dies
# silently is a vault paying zero while displaying a yield". The same is true
# of the indexer one phase early — the site keeps serving its last snapshot,
# with a lag figure climbing in a corner of the top bar that nobody is looking
# at. The lag display is for a user who is on the page; this is for the hours
# when nobody is.
#
# It checks three things that fail independently:
#   the API answers at all
#   the indexer is not stalled  (/api/health returns 503 when it is)
#   the PM2 processes are online
#
# Alerting is whatever ALERT_CMD is set to, so this does not pick a vendor.
# With it unset, output goes to the log and the exit code is non-zero, which
# cron will mail to root on a box with a working MTA.
set -uo pipefail

API=${API:-http://127.0.0.1:3001}
LOG=${LOG:-/var/log/balast/monitor.log}
STATE=${STATE:-/var/lib/balast/monitor.state}
APP_USER=${APP_USER:-balast}

mkdir -p "$(dirname "$LOG")" "$(dirname "$STATE")" 2>/dev/null || true

say() { printf '%s %s\n' "$(date -Is)" "$1" | tee -a "$LOG"; }

# Only alert on a CHANGE of state. A stalled indexer must not send a message
# every five minutes for two days — that is how people start ignoring alerts.
alert() {
  local key=$1 message=$2
  local previous=""
  [[ -f "$STATE" ]] && previous=$(cat "$STATE")
  printf '%s' "$key" > "$STATE"
  [[ "$previous" == "$key" ]] && return 0

  say "ALERT $message"
  if [[ -n "${ALERT_CMD:-}" ]]; then
    # Passed on stdin, so a message containing quotes cannot become a command.
    printf '%s\n' "balast: $message" | sh -c "$ALERT_CMD" || say "ALERT_CMD failed"
  fi
}

clear_alert() {
  local previous=""
  [[ -f "$STATE" ]] && previous=$(cat "$STATE")
  printf 'ok' > "$STATE"
  [[ "$previous" == "ok" || -z "$previous" ]] && return 0
  say "RECOVERED"
  if [[ -n "${ALERT_CMD:-}" ]]; then
    printf '%s\n' "balast: recovered — the indexer is following head again" \
      | sh -c "$ALERT_CMD" || true
  fi
}

# --- the API ---------------------------------------------------------------
body=$(curl -fsS --max-time 10 "$API/api/health" 2>/dev/null)
curl_status=$?
if [[ $curl_status -ne 0 ]]; then
  # 503 is a real answer, not a failure to answer: read it without -f.
  body=$(curl -sS --max-time 10 "$API/api/health" 2>/dev/null)
  if [[ -z "$body" ]]; then
    alert "api-down" "the API is not answering on $API"
    exit 1
  fi
fi

status=$(printf '%s' "$body" | grep -o '"status":"[a-z-]*"' | head -1 | cut -d'"' -f4)
lag=$(printf '%s' "$body" | grep -o '"lagSeconds":[0-9.]*' | head -1 | cut -d: -f2)

case "$status" in
  never-indexed)
    alert "never-indexed" \
      "the indexer has never written a block — check USDG_ADDRESS and pm2 logs balast-indexer"
    exit 1
    ;;
  stalled)
    alert "stalled" \
      "the indexer is ${lag%.*}s behind head; the site is showing numbers that old"
    exit 1
    ;;
  # A first sync is months behind and working as designed: no alert. It
  # becomes "stalled" — and alerts — only if it stops advancing.
  ok|catching-up) ;;
  *)
    alert "unknown" "/api/health returned no status field: ${body:0:200}"
    exit 1
    ;;
esac

# --- the processes ---------------------------------------------------------
# The API can answer while the indexer is a crash loop, so check both.
if command -v pm2 >/dev/null; then
  offline=""
  for app in balast-web balast-api balast-indexer; do
    state=$(runuser -u "$APP_USER" -- pm2 jlist 2>/dev/null \
      | grep -o "\"name\":\"$app\",\"pm2_env\":{[^}]*\"status\":\"[a-z]*\"" \
      | grep -o '"status":"[a-z]*"' | cut -d'"' -f4 | head -1)
    [[ "$state" == "online" ]] || offline="$offline $app(${state:-missing})"
  done
  if [[ -n "$offline" ]]; then
    alert "pm2-offline" "not online:$offline"
    exit 1
  fi
fi

clear_alert
say "ok — lag ${lag%.*}s"
