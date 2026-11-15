#!/usr/bin/env bash
#
# Every deploy after the first. Run as root:
#
#   bash /var/www/balast/deploy/deploy.sh
#   DEPLOY_BRANCH=<branch> bash /var/www/balast/deploy/deploy.sh   # switch branch
#
# Builds and migrates before it reloads, so a build that fails leaves the
# running version serving rather than taking the site down.
set -euo pipefail

APP_USER=balast
APP_DIR=/var/www/balast

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
cd "$APP_DIR"

as_app() { runuser -u "$APP_USER" -- "$@"; }

# The branch to deploy: DEPLOY_BRANCH when given, otherwise the branch the box
# is already on. It used to be a constant here, which meant moving the site to
# another branch took an edit on the server before the first deploy could run.
BRANCH="${DEPLOY_BRANCH:-$(as_app git rev-parse --abbrev-ref HEAD)}"
[[ "$BRANCH" != "HEAD" ]] || { echo "detached HEAD: set DEPLOY_BRANCH=<branch>"; exit 1; }

# ---------------------------------------------------------------------------
# Pull, then hand over to the version that was pulled.
#
# Bash reads a script incrementally, by byte offset. `git checkout` rewrites
# THIS FILE while bash is part-way through it, so execution continues at the
# same offset into the new, longer file — and what runs is a splice of the old
# script and the new one. That is not theoretical: it is why a deploy whose
# migration step had already been fixed still ran the unfixed line and failed
# on a missing DATABASE_URL.
#
# So the update is its own stage. Fetch, check out, then `exec` the new copy,
# which skips this block and runs start to finish from one file.
# ---------------------------------------------------------------------------
if [[ "${BALAST_DEPLOY_STAGE:-}" != "run" ]]; then
  as_app git fetch origin "$BRANCH"
  as_app git checkout -B "$BRANCH" "origin/$BRANCH"
  export BALAST_DEPLOY_STAGE=run
  # As the owner: git refuses a repository owned by somebody else, and this
  # script runs as root against a tree owned by $APP_USER.
  echo "==> running $(as_app git rev-parse --short HEAD)"
  exec bash "$APP_DIR/deploy/deploy.sh" "$@"
fi

# Prisma's CLI does its own `.env` discovery, and it does not find the file
# when run through `runuser` — it reported "Environment variable not found:
# DATABASE_URL" against a file sitting in the working directory. Rather than
# work out whose fault that is, pass the value explicitly: a deploy should not
# depend on another tool's search path.
#
# Only DATABASE_URL is read. Sourcing the whole file would pull every other
# secret into this shell for no reason.
db_url() {
  grep -E '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'
}

DATABASE_URL=$(db_url)
if [[ -z "$DATABASE_URL" ]]; then
  echo "no DATABASE_URL in $APP_DIR/.env — the migration and the build need it"
  exit 1
fi
export DATABASE_URL

# postinstall runs `prisma generate`, which validates the schema and so needs
# DATABASE_URL present even though it never connects.
as_app env DATABASE_URL="$DATABASE_URL" npm ci

# DATA_SOURCE comes from .env, which the build reads, not from here. Pinning
# it on the build line is how a box ends up serving simulated numbers because
# someone forgot to change one word in a script. deploy/data-source.sh is the
# one way to change it.
as_app npm run build

# Migrations before the reload: the new code may need the new columns, and
# `migrate deploy` only applies what is pending, so this is a no-op most runs.
as_app env DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy

# startOrReload, not reload.
#
# `pm2 reload <name>` does not reliably revive a process already in `errored`
# state — and that is exactly when a deploy is most needed, because the deploy
# is usually the fix. A crashed process would silently stay crashed through
# the one command meant to repair it. `startOrReload` against the ecosystem
# file starts whatever is not running and reloads whatever is.
as_app pm2 startOrReload ecosystem.config.js --update-env
as_app pm2 save

# Clear the restart counters, so `pm2 status` shows what happened since this
# deploy rather than a five-figure number from before the fix.
as_app pm2 reset all >/dev/null 2>&1 || true

# Only touch nginx if the config in the repo changed — and never install one
# that names a certificate the box does not have. nginx refuses to start with
# a missing ssl_certificate, so installing it would leave a config on disk that
# takes the site down at the next restart, whatever the reload said. A new
# domain gets its certificate from deploy/switch-domain.sh first.
#
# Comments are stripped first. The config's header prose ("ssl_certificate
# points at a file…") and its commented-out tidewall.live stanza both match
# the pattern, and reading them as directives refused every install with
# "missing: points, tidewall.live/…" — a guard that blocked the config it was
# guarding, while nginx itself would have loaded it fine.
missing_certs() {
  sed 's/#.*//' "$1" | { grep -oE '^[[:space:]]*ssl_certificate(_key)?[[:space:]]+[^;]+' || true; } | awk '{print $2}' |
    while read -r f; do [[ -s "$f" ]] || echo "$f"; done
}
if ! diff -q deploy/nginx.conf /etc/nginx/sites-available/balast >/dev/null 2>&1; then
  missing=$(missing_certs deploy/nginx.conf)
  if [[ -n "$missing" ]]; then
    echo "==> nginx config NOT installed: these certificates are not on the box yet:"
    echo "$missing" | sed 's/^/      /'
    echo "    run: bash $APP_DIR/deploy/switch-domain.sh"
  else
    # Don't install the map if something else on the box already defines
    # $connection_upgrade: a duplicate `map` fails `nginx -t`, and on a shared
    # server that takes every other site down on the next reload.
    if ! grep -rqs 'connection_upgrade' /etc/nginx/conf.d /etc/nginx/nginx.conf; then
      install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
    fi
    # Kept so a config nginx rejects is taken back off the disk: left there,
    # it would pass nothing now and take the site down at the next restart.
    cp -a /etc/nginx/sites-available/balast /etc/nginx/sites-available/balast.previous 2>/dev/null || true
    install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast
    # The old domain's HTTPS redirect, while its certificate is still here.
    if [[ -z "$(missing_certs deploy/nginx-legacy.conf)" ]]; then
      install -m 644 deploy/nginx-legacy.conf /etc/nginx/sites-available/balast-legacy
      ln -sf /etc/nginx/sites-available/balast-legacy /etc/nginx/sites-enabled/balast-legacy
    fi
    if nginx -t; then
      systemctl reload nginx
      echo "==> nginx config installed"
    else
      echo "==> nginx rejected the new config; the previous one is restored"
      [[ -f /etc/nginx/sites-available/balast.previous ]] &&
        cp -a /etc/nginx/sites-available/balast.previous /etc/nginx/sites-available/balast
      nginx -t && systemctl reload nginx
    fi
  fi
fi

as_app pm2 status

echo
# The lag is the honest health check (§7).
#
# Not `curl -f`. /api/health answers 503 ON PURPOSE whenever the indexer is
# behind, has not written a block, or has no USD anchor yet (§15), and -f
# turned every one of those into "API not answering yet" — on a box still on
# its first sync, that was every deploy, in red, about an API that was up.
# Wait for the port after the reload (any HTTP answer counts, 503 included),
# then let the status script read the body and say which state it is.
for _ in $(seq 1 15); do
  curl -s -o /dev/null --max-time 2 localhost:3001/api/health && break
  sleep 1
done
# Warm both caches — the API's snapshot and the web server's copy of it — so
# the first visitor after a deploy opens on the boards, not a loading card.
curl -s -o /dev/null --max-time 120 localhost:3001/api/snapshot || true
curl -s -o /dev/null --max-time 30 localhost:3000/pools || true
node "$APP_DIR/deploy/indexer-status.mjs" || true
