#!/usr/bin/env bash
#
# What is actually wrong with this box?
#
#   bash /var/www/balast/deploy/doctor.sh
#
# Checks every layer in dependency order and stops describing symptoms once it
# finds the first thing that is actually broken, because everything downstream
# of a missing DATABASE_URL is going to look broken too.
#
# It ends with ONE next command. That is the point: three rounds of reading a
# stack trace, guessing, and trying again is worse than one command that says
# what to do.
#
# Read-only. It starts nothing, writes nothing and restarts nothing.
set -uo pipefail

APP_USER=${APP_USER:-balast}
APP_DIR=${APP_DIR:-/var/www/balast}
ENV_FILE="$APP_DIR/.env"
API=${API:-http://127.0.0.1:3001}
DOMAIN=${DOMAIN:-tidewell.live}

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mBAD\033[0m   %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

FAILED=0
NEXT=""
ALSO=""

# Two tiers, because not every failure blocks the ones after it.
#
# `first` is for something the rest of the box cannot work around: no code, no
# .env, no database. Dependency order then makes the earliest one the real
# one, and everything below it is noise.
#
# `also` is for a real failure that blocks only itself — an empty
# USDG_ADDRESS stops the indexer and nothing else. Ranking that above an
# unreachable database sent the operator to look up a token address while the
# database was down, which is exactly the wrong order. It did.
first() { [[ -z "$NEXT" ]] && NEXT="$1"; return 0; }
also()  { [[ -z "$ALSO" ]] && ALSO="$1"; return 0; }

as_app() { runuser -u "$APP_USER" -- "$@" 2>/dev/null; }

# shellcheck source=deploy/pg-port.sh
source "$APP_DIR/deploy/pg-port.sh" 2>/dev/null \
  || source "$(dirname "${BASH_SOURCE[0]}")/pg-port.sh"
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }

# `?schema=public` is Prisma's, not libpq's — psql refuses the whole URL over
# it and the check would report a healthy database as unreachable. Strip the
# query string for psql only; Prisma keeps the URL it was given.
pg_url() { printf '%s' "${1%%\?*}"; }

# ---------------------------------------------------------------- the code --
head_ "code"
# Every git call runs as the user that owns the checkout.
#
# Git refuses to operate on a repository owned by somebody else — "detected
# dubious ownership" — and this script runs as root against a tree owned by
# the app user. Run as root it reported a perfectly good checkout as missing,
# which is a diagnostic tool lying about the first thing it checks.
git_app() { as_app git -C "$APP_DIR" "$@"; }

if [[ -d "$APP_DIR/.git" ]]; then
  HEAD_SHA=$(git_app rev-parse --short HEAD)
  BRANCH=$(git_app rev-parse --abbrev-ref HEAD)
  if [[ -z "$HEAD_SHA" ]]; then
    bad "$APP_DIR/.git exists but git will not read it as $APP_USER"
    first "ls -ld $APP_DIR/.git   # who owns it?"
  fi
  ok "$APP_DIR on ${BRANCH:-?} at ${HEAD_SHA:-?}"
  git_app fetch --quiet origin "$BRANCH" || true
  BEHIND=$(git_app rev-list --count "HEAD..origin/$BRANCH" || echo 0)
  if [[ "${BEHIND:-0}" -gt 0 ]]; then
    warn "$BEHIND commit(s) behind origin/$BRANCH"
    first "bash $APP_DIR/deploy/deploy.sh"
  else
    ok "up to date with origin"
  fi
else
  bad "$APP_DIR is not a git checkout"
  first "clone the repo to $APP_DIR — see README, Deploy"
fi

# ------------------------------------------------------------------- .env ---
head_ "configuration"
if [[ ! -f "$ENV_FILE" ]]; then
  bad "$ENV_FILE is missing"
  first "bash $APP_DIR/deploy/bootstrap.sh"
else
  ok "$ENV_FILE exists ($(stat -c '%U:%G %a' "$ENV_FILE"))"
  DB_URL=$(env_get DATABASE_URL)
  USDG=$(env_get USDG_ADDRESS)
  START_BLOCK=$(env_get START_BLOCK)
  V3_FACTORY=$(env_get V3_FACTORY)

  case "$(env_get DATA_SOURCE)" in
    sim)  ok "DATA_SOURCE sim — the site shows the simulator, labelled Simulated" ;;
    live) ok "DATA_SOURCE live — the site shows the indexer's numbers" ;;
    *)    warn "DATA_SOURCE unset or unknown — the build falls back to sim"
          also "bash $APP_DIR/deploy/data-source.sh live" ;;
  esac

  [[ -n "$DB_URL" ]] && ok "DATABASE_URL set" || {
    bad "DATABASE_URL is empty"
    first "bash $APP_DIR/deploy/bootstrap.sh   # rewrites .env"
  }

  if [[ -z "$USDG" ]]; then
    # Blank is the normal case since §17: the indexer discovers the anchor
    # itself. This used to say BAD, which on a fresh box sent the operator
    # looking up an address nothing needed.
    ok "USDG_ADDRESS blank — the indexer discovers the anchor (usdgSource in /api/health)"
  elif [[ ! "$USDG" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    bad "USDG_ADDRESS is not an address: $USDG"
    also "cd $APP_DIR && ./deploy/set-env.sh USDG_ADDRESS 0x..."
  else
    ok "USDG_ADDRESS $USDG"
  fi

  if [[ "${START_BLOCK:-0}" == "0" || -z "${START_BLOCK:-}" ]]; then
    warn "START_BLOCK is 0 — the first sync scans from genesis, which on ~100ms blocks is a long wait"
  else
    ok "START_BLOCK $START_BLOCK"
  fi
  [[ -n "$V3_FACTORY" ]] && ok "V3_FACTORY $V3_FACTORY" \
    || warn "V3_FACTORY unset — v3 pools will only be those hand-listed in V3_POOLS (§4)"
fi

# --------------------------------------------------------------- database ---
head_ "database"
if [[ -n "${DB_URL:-}" ]]; then
  PSQL_URL=$(pg_url "$DB_URL")
  ENV_PORT=$(printf '%s' "$DB_URL" | sed -E 's|.*@[^:]+:([0-9]+)/.*|\1|')
  # What port is the cluster on, asked over the socket rather than assumed?
  # Everything that sets this box up talks to postgres over its socket, which
  # finds the default cluster whatever its port; DATABASE_URL uses TCP. When
  # those disagree the database exists and the URL cannot reach it, and the
  # error — "Can't reach database server" — reads exactly like postgres being
  # down. Debian puts a second cluster on 5433, so on a shared box this is the
  # normal case rather than an edge one.
  REAL_PORT=$(pg_detect_port || true)

  if psql "$PSQL_URL" -tAc 'select 1' >/dev/null 2>&1; then
    ok "postgres reachable on port ${ENV_PORT:-?}"
    APPLIED=$(psql "$PSQL_URL" -tAc \
      "select count(*) from _prisma_migrations where finished_at is not null" 2>/dev/null || echo "")
    if [[ -z "$APPLIED" ]]; then
      bad "no _prisma_migrations table — migrations have never run"
      first "bash $APP_DIR/deploy/deploy.sh"
    else
      ON_DISK=$(find "$APP_DIR/prisma/migrations" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
      if [[ "$APPLIED" -lt "$ON_DISK" ]]; then
        bad "$APPLIED of $ON_DISK migration(s) applied"
        first "bash $APP_DIR/deploy/deploy.sh"
      else
        ok "$APPLIED migration(s) applied"
      fi
      for t in pools swap_events pool_fee_hourly; do
        N=$(psql "$PSQL_URL" -tAc "select count(*) from $t" 2>/dev/null || echo "?")
        printf '        %-18s %s row(s)\n' "$t" "$N"
      done
    fi
  elif [[ -z "$REAL_PORT" ]]; then
    bad "postgres is not answering on its unix socket — the cluster is down or absent"
    first "pg_lsclusters; systemctl status postgresql --no-pager"
  elif [[ -n "$ENV_PORT" && "$ENV_PORT" != "$REAL_PORT" ]]; then
    # The specific failure, named. Without this the message is "cannot
    # connect", which sends you to check whether postgres is running — and it
    # is, on a different port.
    bad ".env points at port $ENV_PORT but the cluster is on $REAL_PORT"
    first "bash $APP_DIR/deploy/bootstrap.sh   # corrects the port in .env"
  else
    LISTEN=$(pg_listen_addresses "$REAL_PORT")
    if [[ "$LISTEN" != *"localhost"* && "$LISTEN" != *"127.0.0.1"* && "$LISTEN" != "*" ]]; then
      bad "the cluster answers on its socket but listen_addresses is '$LISTEN' — it refuses 127.0.0.1"
      first "edit listen_addresses in postgresql.conf, then: systemctl restart postgresql"
    else
      bad "port $ENV_PORT is right and the cluster is up, so the role or password is wrong"
      first "bash $APP_DIR/deploy/bootstrap.sh   # rotates the password and rewrites .env"
    fi
  fi
else
  warn "skipped — no DATABASE_URL"
fi

if [[ -d "$APP_DIR/node_modules/.prisma/client" ]]; then
  ok "prisma client generated"
else
  bad "prisma client not generated — the API and indexer cannot import it"
  first "bash $APP_DIR/deploy/deploy.sh"
fi

# ------------------------------------------------------------- processes ----
head_ "processes"
if command -v pm2 >/dev/null; then
  # Parse pm2's JSON with a JSON parser.
  #
  # This was grep and cut over `pm2 jlist`, which is a nested document — the
  # pattern stopped at the first closing brace of a nested object and found no
  # status at all, so it reported every process as "not running" while the
  # site was up and serving. A diagnostic that invents a failure is worse than
  # one that misses a real one, because it sends you looking in the wrong place.
  PM2_JSON=$(as_app pm2 jlist)
  PM2_REPORT=$(printf '%s' "$PM2_JSON" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let list = [];
      try { list = JSON.parse(raw); } catch { process.stdout.write("PARSE_FAIL\n"); return; }
      const by = new Map(list.map((p) => [p.name, p]));
      for (const name of ["balast-web", "balast-api", "balast-indexer", "balast-keeper"]) {
        const p = by.get(name);
        if (!p) { console.log(`${name}\tmissing\t0`); continue; }
        const env = p.pm2_env || {};
        console.log(`${name}\t${env.status || "unknown"}\t${env.restart_time ?? 0}`);
      }
    });
  ' 2>/dev/null)

  if [[ -z "$PM2_REPORT" || "$PM2_REPORT" == "PARSE_FAIL" ]]; then
    bad "could not read pm2's process list as $APP_USER"
    first "runuser -u $APP_USER -- pm2 list"
  else
    while IFS=$'\t' read -r name status restarts; do
      [[ -z "$name" ]] && continue
      case "$status" in
        online) ok "$name online (${restarts} restarts)" ;;
        errored|stopped)
          bad "$name is ${status} after ${restarts} restart(s)"
          first "runuser -u $APP_USER -- pm2 logs $name --lines 30 --nostream"
          ;;
        missing)
          bad "$name is not in pm2 at all"
          first "bash $APP_DIR/deploy/deploy.sh"
          ;;
        *) bad "$name is ${status}"; first "runuser -u $APP_USER -- pm2 list" ;;
      esac
    done <<< "$PM2_REPORT"
  fi

  systemctl is-enabled "pm2-$APP_USER" >/dev/null 2>&1 \
    && ok "pm2-$APP_USER enabled — survives a reboot" \
    || bad "pm2-$APP_USER NOT enabled — a reboot leaves nginx serving 502s"
else
  bad "pm2 is not installed"
fi

# -------------------------------------------------------------------- api ---
head_ "api"
BODY=$(curl -sS --max-time 10 "$API/api/health" 2>/dev/null)
if [[ -z "$BODY" ]]; then
  bad "no answer from $API/api/health"
else
  # A JSON parser, not grep: the body nests a keeper section with statuses of
  # its own, and grep over nested JSON is how this script once invented a
  # failure (see the processes section).
  HEALTH=$(printf '%s' "$BODY" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      let h;
      try { h = JSON.parse(raw); } catch { return; }
      // "-" for an empty field: tab is whitespace to `read`, so two tabs in
      // a row would collapse and shift every field after them.
      const one = (s) => String(s ?? "").replace(/[\t\n]+/g, " ").slice(0, 300) || "-";
      console.log([one(h.status), Math.round(Number(h.indexed?.lagSeconds ?? 0)), one(h.message),
        one(h.keeper?.status), one(h.keeper?.message)].join("\t"));
    });
  ' 2>/dev/null)
  IFS=$'\t' read -r STATUS LAG MESSAGE KEEPER KEEPER_MESSAGE <<< "$HEALTH"
  case "$STATUS" in
    ok) ok "indexer following head (lag ${LAG}s)" ;;
    catching-up) ok "indexer catching up and advancing (${LAG}s behind) — a first sync, working" ;;
    no-anchor) warn "no USD anchor yet — normal until the indexer reaches the WETH/USDG pool: $MESSAGE" ;;
    stalled)
      bad "indexer stalled — ${LAG}s behind; the site is showing numbers that old"
      first "runuser -u $APP_USER -- pm2 logs balast-indexer --lines 30 --nostream"
      ;;
    never-indexed)
      bad "the indexer has never written a block"
      first "runuser -u $APP_USER -- pm2 logs balast-indexer --lines 30 --nostream"
      ;;
    keeper-overdue) ;; # reported under "keeper" below
    misconfigured) bad "misconfigured: $MESSAGE"; first "bash $APP_DIR/deploy/set-env.sh" ;;
    *) bad "unexpected health body: ${BODY:0:160}" ;;
  esac

  # The keeper (P4), from what the chain recorded about each router. Vaults
  # need no keeper. No router is "not needed yet", which is fine, not a warning.
  head_ "keeper"
  case "$KEEPER" in
    not-needed) ok "not needed yet — no router deployed (vaults need no keeper)" ;;
    ok) ok "$KEEPER_MESSAGE" ;;
    unknown) warn "$KEEPER_MESSAGE" ;;
    overdue)
      bad "$KEEPER_MESSAGE"
      also "runuser -u $APP_USER -- pm2 logs balast-keeper --lines 40 --nostream"
      ;;
    -|"") warn "this API does not report the keeper (deployed before it)" ;;
    *) warn "keeper status \"$KEEPER\": $KEEPER_MESSAGE" ;;
  esac
fi

# ------------------------------------------------------------------ nginx ---
head_ "nginx"
if nginx -t >/dev/null 2>&1; then
  ok "config test passes"
else
  bad "nginx -t FAILS — no site on this box can reload"
  first "nginx -t"
fi
[[ -L /etc/nginx/sites-enabled/balast || -f /etc/nginx/sites-enabled/balast ]] \
  && ok "balast site enabled" || bad "balast site not in sites-enabled"
grep -q '/api/' /etc/nginx/sites-available/balast 2>/dev/null \
  && ok "nginx proxies /api/" \
  || { bad "nginx has no /api/ block — the browser cannot reach the indexer"
       first "cd $APP_DIR && install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast && nginx -t && systemctl reload nginx"; }

CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
if [[ -f "$CERT" ]]; then
  DAYS=$(( ($(date -d "$(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)" +%s) - $(date +%s)) / 86400 ))
  [[ "$DAYS" -gt 14 ]] && ok "certificate valid for $DAYS more day(s)" \
                       || bad "certificate expires in $DAYS day(s)"
else
  bad "no certificate for $DOMAIN"
fi

# ------------------------------------------------------------------- disk ---
head_ "disk"
USE=$(df -P "$APP_DIR" | awk 'NR==2{print $5}' | tr -d '%')
[[ "$USE" -lt 90 ]] && ok "${USE}% used on $(df -P "$APP_DIR" | awk 'NR==2{print $6}')" \
                    || bad "${USE}% used — writes will start failing"

# ----------------------------------------------------------------- verdict --
printf '\n\033[1mverdict\033[0m\n'
if [[ "$FAILED" -eq 0 ]]; then
  echo "  Everything checks out."
  exit 0
fi
echo "  Something above is broken. The first failure is the one that matters —"
echo "  everything downstream of it will look broken too."
if [[ -n "$NEXT" ]]; then
  printf '\n\033[1mnext\033[0m\n  %s\n' "$NEXT"
  [[ -n "$ALSO" ]] && printf '\n\033[1mthen\033[0m\n  %s\n' "$ALSO"
  printf '\n'
elif [[ -n "$ALSO" ]]; then
  printf '\n\033[1mnext\033[0m\n  %s\n\n' "$ALSO"
fi
exit 1
