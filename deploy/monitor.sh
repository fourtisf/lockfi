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
      "the indexer has never written a block — check USDG_ADDRESS and pm2 logs lockfi-indexer"
    exit 1
    ;;
  stalled)
    idle=$(printf '%s' "$body" | grep -o '"idleSeconds":[0-9.]*' | head -1 | cut -d: -f2)
    alert "stalled" \
      "the indexer has written nothing for ${idle%.*}s; the site is showing numbers ${lag%.*}s old"
    exit 1
    ;;
  no-anchor)
    alert "no-anchor" \
      "indexing, but no ETH/USDG pool has been found; every page is on the waiting panel"
    exit 1
    ;;
  # A first sync or a catch-up is the indexer working, with the lag on the
  # site. Alerting on it for forty hours would teach everyone to mute this.
  # `working` is a heartbeating stage that writes no block — a full rebuild
  # or the factory's history — and a dead one turns into `stalled` above.
  ok | syncing | behind | working) ;;
  *)
    alert "unknown" "/api/health returned no status field: ${body:0:200}"
    exit 1
    ;;
esac

# --- the processes ---------------------------------------------------------
# The API can answer while the indexer is a crash loop, so check both.
#
# Parsed with a JSON parser, as doctor.sh does (§17). This was grep over
# `pm2 jlist`, matching `"name":"x","pm2_env":{` — PM2 puts other keys between
# those two and the nested object closes long before `status`, so the pattern
# never matched, every process read as `missing`, and this script alerted
# "pm2-offline" on every run over a box that was up. A monitor that invents a
# failure is the one that gets muted.
if command -v pm2 >/dev/null; then
  offline=$(runuser -u "$APP_USER" -- pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let list = [];
      try { list = JSON.parse(raw); } catch { process.stdout.write(" pm2(unreadable)"); return; }
      const by = new Map(list.map((p) => [p.name, p]));
      const out = [];
      for (const name of ["lockfi-web", "lockfi-api", "lockfi-indexer", "lockfi-logos", "lockfi-keeper"]) {
        const p = by.get(name);
        const state = p && p.pm2_env && p.pm2_env.status ? p.pm2_env.status : "missing";
        if (state !== "online") out.push(` ${name}(${state})`);
      }
      process.stdout.write(out.join(""));
    });' 2>/dev/null)
  if [[ -n "$offline" ]]; then
    alert "pm2-offline" "not online:$offline"
    exit 1
  fi
fi

clear_alert
say "ok — lag ${lag%.*}s"
