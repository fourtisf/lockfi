#!/usr/bin/env bash
#
# Is the indexer indexing, and is the keeper keeping the routers?
#
# Run from cron every five minutes:
#   */5 * * * * /var/www/balast/deploy/monitor.sh
#
# §8's P3 criterion names the failure this exists for: "a keeper that dies
# silently is a vault paying zero while displaying a yield". The same is true
# of the indexer — the site keeps serving its last snapshot, with a lag
# figure climbing in a corner of the top bar that nobody is looking at. The
# lag display is for a user who is on the page; this is for the hours when
# nobody is.
#
# It checks four things that fail independently:
#   the API answers at all
#   the indexer is not stalled          (/api/health: status "stalled")
#   no router has gone unobserved       (/api/health: status "keeper-overdue")
#   the PM2 processes are online
#
# Vaults need no keeper — they credit fees on every deposit, withdraw, claim
# or poke — so nothing here watches them for a missed harvest. With no router
# deployed the keeper is "not needed yet", which is not a failure and raises
# nothing.
#
# Alerting is whatever ALERT_CMD is set to, so this does not pick a vendor.
# With it unset, output goes to the log and the exit code is non-zero, which
# cron will mail to root on a box with a working MTA.
set -uo pipefail

API=${API:-http://127.0.0.1:3001}
LOG=${LOG:-/var/log/balast/monitor.log}
STATE=${STATE:-/var/lib/balast/monitor.state}
APP_USER=${APP_USER:-balast}
# SKIP_PM2=1 for a box without PM2 (and the test that runs this script).
SKIP_PM2=${SKIP_PM2:-0}

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
  say "RECOVERED from $previous"
  if [[ -n "${ALERT_CMD:-}" ]]; then
    printf '%s\n' "balast: recovered from $previous — /api/health is ok again" \
      | sh -c "$ALERT_CMD" || true
  fi
}

# --- the API ---------------------------------------------------------------
# 503 is a real answer, not a failure to answer: read the body either way.
body=$(curl -sS --max-time 10 "$API/api/health" 2>/dev/null)
if [[ -z "$body" ]]; then
  alert "api-down" "the API is not answering on $API"
  exit 1
fi

# Parsed with a JSON parser. The body nests a keeper section with statuses of
# its own, and grep over a nested document is how doctor.sh once reported
# every process down while the site was serving (§17).
if ! command -v node >/dev/null; then
  # Say what is actually wrong, rather than misreading the body as a status.
  alert "monitor-broken" "monitor.sh cannot read /api/health: node is not on PATH ($PATH)"
  exit 1
fi
fields=$(printf '%s' "$body" | node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let h;
    try { h = JSON.parse(raw); } catch { console.log("status=unparseable"); return; }
    const one = (s) => String(s ?? "").replace(/\s+/g, " ").slice(0, 400);
    const k = h.keeper || {};
    console.log("status=" + one(h.status));
    console.log("lag=" + Math.round(Number(h.indexed?.lagSeconds ?? 0)));
    console.log("message=" + one(h.message));
    console.log("keeper=" + one(k.status));
    console.log("keeper_message=" + one(k.message));
  });
' 2>/dev/null)

status="" lag="0" message="" keeper="" keeper_message=""
while IFS='=' read -r key value; do
  case "$key" in
    status) status=$value ;;
    lag) lag=$value ;;
    message) message=$value ;;
    keeper) keeper=$value ;;
    keeper_message) keeper_message=$value ;;
  esac
done <<< "$fields"

case "$status" in
  never-indexed)
    alert "never-indexed" "the indexer has never written a block — check: runuser -u $APP_USER -- pm2 logs balast-indexer"
    exit 1
    ;;
  stalled)
    alert "stalled" "the indexer is ${lag}s behind head and not moving; the site is showing numbers that old"
    exit 1
    ;;
  keeper-overdue)
    alert "keeper-overdue" "${keeper_message:-a router has gone unobserved by the keeper}"
    exit 1
    ;;
  misconfigured)
    alert "misconfigured" "${message:-the API reports a configuration error}"
    exit 1
    ;;
  # No USD anchor yet: a first sync's normal state until the WETH/USDG pool is
  # found. /api/health answers 503 for it, so an uptime check sees it; this
  # does not page anyone for the indexer doing its job.
  no-anchor) say "waiting — no USD anchor yet: ${message}" ;;
  # A first sync is months behind and working as designed: no alert. It
  # becomes "stalled" — and alerts — only if it stops advancing.
  ok|catching-up) ;;
  *)
    alert "unknown" "/api/health returned an unrecognised status \"${status}\": ${body:0:200}"
    exit 1
    ;;
esac

# --- the processes ---------------------------------------------------------
# The API can answer while the indexer or the keeper is a crash loop, so
# check each. An idle keeper (nothing deployed, or no key) is online.
if [[ "$SKIP_PM2" != "1" ]] && command -v pm2 >/dev/null; then
  offline=$(runuser -u "$APP_USER" -- pm2 jlist 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let list;
      try { list = JSON.parse(raw); } catch { console.log("pm2(unreadable)"); return; }
      const by = new Map(list.map((p) => [p.name, p]));
      const out = [];
      for (const name of ["balast-web", "balast-api", "balast-indexer", "balast-keeper"]) {
        const status = by.get(name)?.pm2_env?.status;
        if (status !== "online") out.push(`${name}(${status || "missing"})`);
      }
      console.log(out.join(" "));
    });
  ' 2>/dev/null)
  if [[ -n "$offline" ]]; then
    alert "pm2-offline" "not online: $offline"
    exit 1
  fi
fi

clear_alert
say "${status} — lag ${lag}s; keeper ${keeper:-unknown}"
