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
DOMAIN=${DOMAIN:-lockfi.org}

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
  # One git command run as root in the tree leaves root-owned object
  # directories under .git, and the next fetch as $APP_USER fails with
  # "insufficient permission for adding an object to repository database" —
  # which is what the deploy stopped on, before pulling anything. Name it
  # here, because the fetch below would only swallow it.
  STRAY=$(find "$APP_DIR" -not -user "$APP_USER" 2>/dev/null | wc -l)
  if [[ "$STRAY" -gt 0 ]]; then
    bad "$STRAY path(s) under $APP_DIR not owned by $APP_USER — a git command run as root? the deploy's fetch fails on these"
    first "chown -R $APP_USER:$APP_USER $APP_DIR && bash $APP_DIR/deploy/deploy.sh"
  fi
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

  [[ -n "$DB_URL" ]] && ok "DATABASE_URL set" || {
    bad "DATABASE_URL is empty"
    first "bash $APP_DIR/deploy/bootstrap.sh   # rewrites .env"
  }

  if [[ -z "$USDG" ]]; then
    # Not a fault since §17: the anchor is discovered from the tokens the
    # indexer finds, and an empty override is the normal state. Reporting it
    # as BAD sent the operator off to look up an address the box was already
    # looking for itself.
    ok "USDG_ADDRESS unset — the USD anchor is discovered from indexed tokens"
  elif [[ ! "$USDG" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    bad "USDG_ADDRESS is not an address: $USDG"
    also "cd $APP_DIR && ./deploy/set-env.sh USDG_ADDRESS 0x..."
  else
    ok "USDG_ADDRESS $USDG"
  fi

  # Not a fault: every public endpoint here is pruned, so the deployment block
  # cannot be found, and a START_BLOCK above a pool's creation would miss the
  # mint that funded it (§17). Genesis is the start that misses nothing, and a
  # sync under way resumes from its own cursor, not from this value.
  if [[ "${START_BLOCK:-0}" == "0" || -z "${START_BLOCK:-}" ]]; then
    ok "START_BLOCK unset — the sync reads from genesis, the only start that misses no pool's funding mint"
  else
    ok "START_BLOCK $START_BLOCK"
  fi
  # Unset is the normal state since §20: Uniswap's own v3 factory, from its
  # registry, is the default in lib/chain.ts. The old wording predated that.
  [[ -n "$V3_FACTORY" ]] && ok "V3_FACTORY $V3_FACTORY" \
    || ok "V3_FACTORY unset — Uniswap's own v3 factory (lib/chain.ts) is followed"
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
      for (const name of ["lockfi-web", "lockfi-api", "lockfi-indexer", "lockfi-logos", "lockfi-keeper"]) {
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
  STATUS=$(printf '%s' "$BODY" | grep -o '"status":"[a-z-]*"' | head -1 | cut -d'"' -f4)
  LAG=$(printf '%s' "$BODY" | grep -o '"lagSeconds":[0-9.]*' | head -1 | cut -d: -f2)
  case "$STATUS" in
    ok) ok "indexer following head (lag ${LAG%.*}s)" ;;
    syncing)
      # A first sync: the lag is days by definition and the site says so in
      # the top bar. Not a fault; it is the one state where waiting is right.
      PCT=$(printf '%s' "$BODY" | grep -o '"progressPct":[0-9.]*' | head -1 | cut -d: -f2)
      ok "first sync running — ${PCT:-?}% of the chain, numbers ${LAG%.*}s of chain time behind"
      ;;
    behind)
      warn "indexer catching up — newest block is ${LAG%.*}s old"
      ;;
    working)
      # A stage that writes no block for hours — the full rebuild a repair
      # migration forces, or the factory's history — with a live heartbeat.
      # The cursor is stale by definition here and that is not a stall.
      STAGE=$(printf '%s' "$BODY" | grep -o '"stage":"[^"]*"' | head -1 | cut -d'"' -f4)
      DETAIL=$(printf '%s' "$BODY" | grep -o '"detail":"[^"]*"' | head -1 | cut -d'"' -f4)
      SECS=$(printf '%s' "$BODY" | grep -o '"seconds":[0-9.]*' | head -1 | cut -d: -f2)
      SECS=${SECS%.*}
      ok "indexer busy — ${STAGE:-a stage}${DETAIL:+ ($DETAIL)}, $(( ${SECS:-0} / 60 )) min so far, alive; no block until it finishes"
      ;;
    stalled)
      IDLE=$(printf '%s' "$BODY" | grep -o '"idleSeconds":[0-9.]*' | head -1 | cut -d: -f2)
      bad "indexer stalled — nothing written for ${IDLE%.*}s; the site is showing numbers ${LAG%.*}s old"
      first "runuser -u $APP_USER -- pm2 logs lockfi-indexer --lines 30 --nostream"
      ;;
    never-indexed)
      bad "the indexer has never written a block"
      first "runuser -u $APP_USER -- pm2 logs lockfi-indexer --lines 30 --nostream"
      ;;
    no-anchor)
      # Blocks are being indexed but no ETH/USDG pool has been seen, so
      # nothing has a dollar figure and every page shows the waiting panel.
      # Whether that is a problem depends entirely on `syncing`: a first sync
      # has not reached the pools yet, a caught-up one never will.
      SYNCING=$(printf '%s' "$BODY" | grep -o '"syncing":[a-z]*' | head -1 | cut -d: -f2)
      PCT=$(printf '%s' "$BODY" | grep -o '"progressPct":[0-9.]*' | head -1 | cut -d: -f2)
      if [[ "$SYNCING" == "true" ]]; then
        warn "no USD anchor yet — first sync at ${PCT:-?}% of the chain. This resolves itself."
      else
        bad "caught up, and no ETH/USDG pool found — every page is on the waiting panel"
        # The indexer's own tables are the authoritative list of what this
        # chain trades; a chain scan from head only sees pools created in the
        # window it scans, and the anchor pool was created once, long ago.
        also "runuser -u $APP_USER -- npm run --prefix $APP_DIR tokens:indexed"
      fi
      ;;
    misconfigured)
      bad "the API says it is misconfigured"
      first "curl -s $API/api/health"
      ;;
    *) bad "unexpected health body: ${BODY:0:160}" ;;
  esac

  # The chain's head, read beside the backfill (§25). This is what makes the
  # board's volume current while the backfill is still weeks behind, so a
  # board reading `chain` on every row is answered here first.
  HEAD=${BODY#*\"head\":}
  H_SWAPS=$(printf '%s' "$HEAD" | grep -o '"swaps":[0-9]*' | head -1 | cut -d: -f2)
  H_SECS=$(printf '%s' "$HEAD" | grep -o '"seconds":[0-9]*' | head -1 | cut -d: -f2)
  if [[ -z "${H_SECS:-}" ]]; then
    warn "head reader: nothing written yet — the board's volume is the backfill's day"
    also "runuser -u $APP_USER -- pm2 logs lockfi-indexer --lines 30 --nostream"
  elif [[ "${H_SECS:-0}" -gt 1800 ]]; then
    warn "head reader: newest swap is $(( H_SECS / 60 ))m old — the board's volume is going stale"
  else
    ok "head reader: ${H_SWAPS:-0} swaps, newest ${H_SECS}s old — the board's volume is current"
  fi

  # The portfolio's scan for Uniswap v4 positions the indexer has not reached
  # yet (§30). Without it a position minted since the indexer's last block is
  # not on /portfolio — and a position not on the page cannot be withdrawn
  # there. Its error carries every endpoint's own reason, hosts only.
  if printf '%s' "$BODY" | grep -q '"portfolioScan":null'; then
    warn "portfolio scan: off (PORTFOLIO_CHAIN=false) — /portfolio lists only the indexer's weeks-old record"
    also "bash $APP_DIR/deploy/set-env.sh PORTFOLIO_CHAIN true && runuser -u $APP_USER -- pm2 restart lockfi-api --update-env"
  elif printf '%s' "$BODY" | grep -q '"portfolioScan"'; then
    SCAN=${BODY#*\"portfolioScan\":}
    # Just this object: it has no nested braces, and a null field here must not
    # be read from the next object in the body.
    SCAN=${SCAN%%\}*}
    S_ERR=$(printf '%s' "$SCAN" | grep -o '"lastError":"[^"]*"' | head -1 | cut -d'"' -f4)
    S_SWEPT=$(printf '%s' "$SCAN" | grep -o '"swept":[a-z]*' | head -1 | cut -d: -f2)
    S_AT=$(printf '%s' "$SCAN" | grep -o '"sweptTo":"[0-9]*"' | head -1 | cut -d'"' -f4)
    S_TO=$(printf '%s' "$SCAN" | grep -o '"to":"[0-9]*"' | head -1 | cut -d'"' -f4)
    if [[ -n "${S_ERR:-}" ]]; then
      warn "portfolio scan: failing — $S_ERR"
      also "runuser -u $APP_USER -- pm2 logs lockfi-api --lines 50 --nostream | grep 'v4 scan'"
    elif [[ "${S_SWEPT:-false}" != "true" ]]; then
      # Expected for a few minutes after every restart, and the explorer and
      # the browser's own record cover the gap meanwhile: not a fault.
      ok "portfolio scan: first sweep running (id ${S_AT:-?} of ${S_TO:-?}) — done in a few minutes"
    else
      ok "portfolio scan: the newest v4 ids up to ${S_TO:-?} read"
    fi
    EXPL=${BODY#*\"portfolioExplorer\":}
    EXPL=${EXPL%%\}*}
    if printf '%s' "$BODY" | grep -q '"portfolioExplorer":{'; then
      E_ERR=$(printf '%s' "$EXPL" | grep -o '"lastError":"[^"]*"' | head -1 | cut -d'"' -f4)
      E_OK=$(printf '%s' "$EXPL" | grep -o '"lastOkAt":"[^"]*"' | head -1 | cut -d'"' -f4)
      if [[ -n "${E_ERR:-}" ]]; then
        # Older v4 positions are found through the explorer; without it they
        # appear only as the indexer reaches them, and the page says so.
        warn "portfolio explorer: $E_ERR — v4 positions older than the scan's window may be missing from /portfolio"
      elif [[ -n "${E_OK:-}" ]]; then
        ok "portfolio explorer: answering — every v4 position a wallet holds is found, however old"
      else
        ok "portfolio explorer: not asked yet — it is asked when a wallet opens /portfolio"
      fi
    fi
  fi

  # Live v3 pool reserves: the liquidity today's fee yield is divided by
  # (§31). Zero pools for the first minutes after a restart is the first
  # snapshot still being built, not a fault.
  if printf '%s' "$BODY" | grep -q '"poolReserves":{'; then
    RES=${BODY#*\"poolReserves\":}
    RES=${RES%%\}*}
    R_POOLS=$(printf '%s' "$RES" | grep -o '"pools":[0-9]*' | head -1 | cut -d: -f2)
    R_READ=$(printf '%s' "$RES" | grep -o '"read":[0-9]*' | head -1 | cut -d: -f2)
    R_ERR=$(printf '%s' "$RES" | grep -o '"lastError":"[^"]*"' | head -1 | cut -d'"' -f4)
    R_UP=$(printf '%s' "$BODY" | grep -o '"uptimeSeconds":[0-9]*' | head -1 | cut -d: -f2)
    if [[ -n "${R_ERR:-}" ]]; then
      warn "pool reserves: $R_ERR — v3 fee yields fall back to the indexer's figure, labelled with its age"
    elif [[ "${R_READ:-0}" -gt 0 ]]; then
      ok "pool reserves: ${R_READ} of ${R_POOLS:-?} v3 pools read from the chain — fee yield uses today's liquidity"
    elif [[ "${R_POOLS:-0}" -gt 0 ]]; then
      ok "pool reserves: ${R_POOLS} v3 pools followed, first read in progress"
    elif [[ -n "${R_UP:-}" && "${R_UP}" -lt 600 ]]; then
      ok "pool reserves: waiting for the first snapshot (API up ${R_UP}s) — read within a minute of it"
    else
      warn "pool reserves: no v3 pool followed — every fee yield is the indexer's figure, labelled with its age"
    fi
  elif printf '%s' "$BODY" | grep -q '"poolReserves":null'; then
    ok "pool reserves: off (LIVE_RESERVES=false) — fee yields use the indexer's figure, labelled with its age"
  fi

  # The live market feed. A row reading `chain` is showing a day as old as the
  # sync, so how many of the board's tokens an aggregator places is the
  # difference between a current board and a two-month-old one — and when some
  # are unplaced, WHICH ones is the difference between "nobody lists them" and
  # "we are not asking" (§24).
  MARKET=${BODY#*\"market\":}
  M_FOLLOWED=$(printf '%s' "$MARKET" | grep -o '"followed":[0-9]*' | head -1 | cut -d: -f2)
  M_QUOTED=$(printf '%s' "$MARKET" | grep -o '"quoted":[0-9]*' | head -1 | cut -d: -f2)
  M_NOTE=$(printf '%s' "$MARKET" | grep -o '"note":"[^"]*"' | head -1 | cut -d'"' -f4)
  M_UNKNOWN=$(printf '%s' "$MARKET" | grep -o '"unknownTokens":\[[^]]*\]' | head -1 | sed 's/.*\[//; s/\]//; s/"//g')
  if [[ -n "${M_FOLLOWED:-}" && "${M_FOLLOWED:-0}" -gt 0 ]]; then
    if [[ "${M_QUOTED:-0}" -eq 0 ]]; then
      warn "live market: none of $M_FOLLOWED tokens quoted — every row shows the chain's own figures${M_NOTE:+ ($M_NOTE)}"
      also "runuser -u $APP_USER -- npm run --prefix $APP_DIR market:probe -- <ticker>"
    else
      ok "live market: $M_QUOTED of $M_FOLLOWED tokens quoted${M_UNKNOWN:+ — no source has: $M_UNKNOWN}"
    fi
  elif [[ -n "${M_NOTE:-}" ]]; then
    # "No tokens followed yet" is the first snapshot being built, which on the
    # real tables takes a while after every restart. Only a build that has not
    # finished well after the restart is worth a warning.
    UPTIME=$(printf '%s' "$BODY" | grep -o '"uptimeSeconds":[0-9]*' | head -1 | cut -d: -f2)
    if [[ "${M_FOLLOWED:-0}" -eq 0 && -n "${UPTIME:-}" && "${UPTIME}" -lt 600 ]]; then
      ok "live market: starting — the API came up ${UPTIME}s ago and is building its first snapshot"
    else
      warn "live market: $M_NOTE"
      also "runuser -u $APP_USER -- pm2 logs lockfi-api --lines 80 --nostream | grep -i snapshot"
    fi
  fi
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
