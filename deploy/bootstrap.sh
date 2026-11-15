#!/usr/bin/env bash
#
# First-time server setup for tidewell.live. Run once, as root, on a fresh
# Ubuntu VPS whose DNS already points here.
#
#   bash deploy/bootstrap.sh                    # the site shows the indexer's numbers
#   DATA_SOURCE=sim bash deploy/bootstrap.sh    # the site shows the simulator
#
# Safe to re-run: it skips what already exists. It does not reboot and it does
# not apply system updates — do both yourself first.
set -euo pipefail

DOMAIN=tidewell.live
APP_USER=balast
APP_DIR=/var/www/balast
REPO=https://github.com/fourtisf/lockfi.git
BRANCH="${DEPLOY_BRANCH:-claude/happy-johnson-9vztsw}"
NODE_MAJOR=20

# What the site shows. `live` reads the indexer, which on a fresh box has
# nothing yet, so every page honestly says "waiting for the indexer" until the
# first sync reaches the chain head. `sim` is the simulator, labelled
# Simulated on every page, for a full preview meanwhile. The indexer runs and
# syncs in either mode; deploy/data-source.sh switches later.
#
# Read once and unset: from here on .env is the only place it lives, so the
# build cannot quietly pick up a value from this shell instead.
DATA_SOURCE_GIVEN=${DATA_SOURCE+1}
SITE_DATA=${DATA_SOURCE:-live}
unset DATA_SOURCE
[[ "$SITE_DATA" == live || "$SITE_DATA" == sim ]] \
  || { echo "DATA_SOURCE must be live or sim, not '$SITE_DATA'"; exit 1; }

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

# runuser rather than sudo: it is part of util-linux, so it is always present,
# and it is the right tool for root dropping to a service account.
as_app() { runuser -u "$APP_USER" -- "$@"; }

echo "==> does $DOMAIN point here?"
# The certificate is the last step. Finding out there that DNS is wrong costs
# ten minutes of installs and leaves a half-configured box, so ask first.
#
# Exact match, not "contains": a new domain's zone often still carries the
# registrar's parking A record beside ours, and Let's Encrypt may ask either.
# And an AAAA record pointing anywhere else fails the certificate outright,
# because Let's Encrypt tries IPv6 first.
if [[ "${SKIP_DNS_CHECK:-0}" != 1 ]]; then
  here4=$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  here6=$(ip -6 addr show scope global 2>/dev/null | awk '/inet6/ {sub(/\/.*/, "", $2); print $2}' || true)
  dns_ok=1
  for name in "$DOMAIN" "www.$DOMAIN"; do
    got4=$( { getent ahostsv4 "$name" || true; } | awk '{print $1}' | sort -u | paste -sd' ')
    if [[ "$got4" == "$here4" ]]; then
      echo "   $name -> $got4  ok"
    else
      echo "   !! $name resolves to '${got4:-nothing}', but this server is $here4"
      dns_ok=0
    fi
    for ip6 in $( { getent ahosts "$name" || true; } | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ {print $1}' | sort -u); do
      if ! grep -qxF "$ip6" <<<"$here6"; then
        echo "   !! $name has an AAAA record ($ip6) that is not this server"
        dns_ok=0
      fi
    done
  done
  if [[ $dns_ok != 1 ]]; then
    echo
    echo "   Fix the DNS zone for $DOMAIN at the registrar: exactly one A record for"
    echo "   @ and one for www, both $here4, and no AAAA record unless it is this"
    echo "   server's own IPv6. Changes can take a few minutes to be seen. Then run"
    echo "   this script again — nothing has been installed yet."
    echo "   (SKIP_DNS_CHECK=1 skips this check, if you know better.)"
    exit 1
  fi
fi

# A server with unrelated broken third-party repositories — an unsigned
# ClickHouse list, an expired GitHub CLI key — makes `apt-get update` exit
# non-zero. That is not this deploy's problem and not a reason to abort it, so
# report and carry on. `apt-get install` still fails loudly if a package we
# actually need is unavailable.
apt_update_tolerant() {
  local log=/tmp/balast-apt-update.log
  if apt-get update -qq >"$log" 2>&1; then return 0; fi
  echo "!! apt-get update reported errors — continuing anyway:"
  grep -E '^[EW]:' "$log" | sed 's/^/     /' || true
  echo "   (the Ubuntu archives are what this script needs; full log: $log)"
}

echo "==> packages"
apt_update_tolerant
apt-get install -y -qq curl git nginx certbot ca-certificates gnupg \
  postgresql postgresql-client redis-server

echo "==> node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  # Refresh ONLY the NodeSource list, so a broken repo elsewhere cannot
  # interfere with installing node.
  apt-get update -qq \
    -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/nodesource.list \
    -o Dir::Etc::sourceparts=/dev/null \
    -o APT::Get::List-Cleanup=0
  apt-get install -y -qq nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null

echo "==> app user (the front-end does not run as root)"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

echo "==> postgres"
# The cluster Ubuntu creates on install is fine; all this does is make the
# role and database, idempotently. The password is generated here and written
# only to the app's .env — it is never echoed and never in this repository.
systemctl enable --now postgresql
DB_NAME=balast
DB_USER=balast

# Ask the cluster what port it is ACTUALLY on.
#
# Everything below talks to postgres over its unix socket, which finds the
# default cluster whatever port that cluster listens on. DATABASE_URL uses
# TCP. Hardcoding 5432 into it therefore produced a database that existed and
# a URL that could not reach it — "P1001: Can't reach database server" — and
# on a box that already ran PostgreSQL for something else Debian puts the new
# cluster on 5433, so this is the normal case on a shared server, not an edge.
# shellcheck source=deploy/pg-port.sh
source "$APP_DIR/deploy/pg-port.sh" 2>/dev/null || source "$(dirname "${BASH_SOURCE[0]}")/pg-port.sh"
PG_PORT=$(pg_detect_port || true)
if [[ -z "$PG_PORT" ]]; then
  echo "!! postgres is not answering on its unix socket. Clusters on this box:"
  pg_lsclusters 2>/dev/null || echo "   (pg_lsclusters unavailable)"
  systemctl --no-pager status postgresql 2>&1 | head -12 || true
  exit 1
fi
echo "   cluster is on port $PG_PORT"

# -p on every one of these: psql defaults to 5432 even over the socket,
# because the socket file is named .s.PGSQL.<port>.
if ! runuser -u postgres -- psql -p "$PG_PORT" -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  DB_PASS="$(openssl rand -hex 24)"
  runuser -u postgres -- psql -p "$PG_PORT" -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
  echo "   created role $DB_USER"
else
  DB_PASS=""
  echo "   role $DB_USER already exists — leaving its password alone"
fi
if ! runuser -u postgres -- psql -p "$PG_PORT" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  runuser -u postgres -- createdb -p "$PG_PORT" -O "$DB_USER" "$DB_NAME"
  echo "   created database $DB_NAME"
fi

echo "==> redis"
# Only on localhost. Redis with no password on a public interface is how a
# box gets owned; it carries nothing secret here, but it is still a shell.
systemctl enable --now redis-server
if ! grep -qE '^bind 127\.0\.0\.1' /etc/redis/redis.conf; then
  echo "   !! /etc/redis/redis.conf does not bind to 127.0.0.1 — check it"
fi

echo "==> clone"
# Let root use git in this tree too.
#
# The checkout is owned by $APP_USER, and git refuses to operate on a
# repository owned by somebody else — "detected dubious ownership". The
# scripts all run git as the owner, so they do not need this; a person
# SSH'd in as root does, and without it their first `git pull` fails in a
# way that looks like a broken repository rather than a permissions rule.
git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR" \
  || git config --global --add safe.directory "$APP_DIR"

mkdir -p "$APP_DIR" /var/www/certbot /var/log/balast
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/log/balast
if [[ -d "$APP_DIR/.git" ]]; then
  as_app git -C "$APP_DIR" fetch origin "$BRANCH"
  as_app git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  as_app git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> env"
# Written once and then left alone: a redeploy must not regenerate the
# database password or wipe the USDG address someone looked up by hand.
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -z "$DB_PASS" ]]; then
    # The role exists from an earlier run but .env does not, so nothing knows
    # the password any more. Rotate it and write a fresh file.
    #
    # This used to exit with "reset it yourself", which is a dead end: the one
    # command meant to repair the box refused to repair the most likely way it
    # breaks. Rotating is safe precisely BECAUSE the old password is lost —
    # nothing can still be using it.
    echo "   .env is missing and the $DB_USER role already exists — rotating its password"
    DB_PASS="$(openssl rand -hex 24)"
    runuser -u postgres -- psql -p "$PG_PORT" -qc "ALTER ROLE $DB_USER PASSWORD '$DB_PASS'"
  fi
  cat > "$APP_DIR/.env" <<ENVEOF
# DATA_SOURCE: live = the indexer's numbers, sim = the simulator. Fixed when
# the site is BUILT, so change it with deploy/data-source.sh, which rebuilds.
DATA_SOURCE=$SITE_DATA
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$PG_PORT/$DB_NAME?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
API_PORT=3001
API_HOST=127.0.0.1
START_BLOCK=0
INDEXER_BLOCK_RANGE=2000
# Optional. Left blank, the indexer finds the WETH/USDG pool itself — the
# site's one USD anchor — and /api/health says which token it chose and why.
# Set it only to pin a specific token.
USDG_ADDRESS=
LAUNCHPAD_HOOKS=
V3_POOLS=
# The keeper's key: a DEDICATED hot wallet holding only gas, never the
# owner's or the treasury's. It pokes and routes token teams' routers; vaults
# need no keeper. Blank, balast-keeper stays up and signs nothing; with no
# router deployed it is not needed at all. Set it without the key touching
# your shell history: bash deploy/set-env.sh KEEPER_PRIVATE_KEY -
KEEPER_PRIVATE_KEY=
ENVEOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "   wrote $APP_DIR/.env"
else
  echo "   $APP_DIR/.env already exists — left alone"
  # ...except the port, which is a fact about this machine rather than a
  # preference. An .env written when the cluster was assumed to be on 5432
  # points at nothing, and the symptom is a P1001 twenty steps later.
  CURRENT_PORT=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 \
    | sed -E 's|.*@[^:]+:([0-9]+)/.*|\1|')
  if [[ -n "$CURRENT_PORT" && "$CURRENT_PORT" != "$PG_PORT" ]]; then
    echo "   !! its DATABASE_URL points at port $CURRENT_PORT, the cluster is on $PG_PORT"
    TMP_ENV=$(mktemp)
    sed -E "s|(^DATABASE_URL=.*@[^:]+):[0-9]+(/.*)|\1:$PG_PORT\2|" "$APP_DIR/.env" > "$TMP_ENV"
    chown --reference="$APP_DIR/.env" "$TMP_ENV"
    chmod --reference="$APP_DIR/.env" "$TMP_ENV"
    mv "$TMP_ENV" "$APP_DIR/.env"
    echo "      corrected to $PG_PORT"
  fi
  # ...and the data source, but only when this run was asked for one.
  if [[ -n "$DATA_SOURCE_GIVEN" ]]; then
    bash "$APP_DIR/deploy/data-source.sh" "$SITE_DATA" --no-build
  fi
fi

# Prove the URL actually connects, here, rather than letting a migration
# twenty steps later be the first thing that tries it.
ENV_DB_URL=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"')
# psql refuses Prisma's ?schema= suffix outright, so strip it for this check.
if ! psql "${ENV_DB_URL%%\?*}" -tAc 'select 1' >/dev/null 2>&1; then
  echo "!! the DATABASE_URL in $APP_DIR/.env does not connect."
  echo "   cluster port:      $PG_PORT"
  echo "   listen_addresses:  $(pg_listen_addresses "$PG_PORT")"
  echo "   A cluster with listen_addresses unset answers on its socket and"
  echo "   refuses 127.0.0.1, which looks identical to postgres being down."
  pg_lsclusters 2>/dev/null || true
  exit 1
fi
echo "   database reachable over TCP on $PG_PORT"

echo "==> build"
cd "$APP_DIR"
# Prisma's CLI does its own `.env` discovery and does not find the file when
# run through `runuser`. Pass it explicitly rather than depend on that search
# path — `npm ci` needs it too, because postinstall runs `prisma generate`,
# which validates the schema even though it never connects.
DB_URL=$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"')
[[ -n "$DB_URL" ]] || { echo "no DATABASE_URL in $APP_DIR/.env"; exit 1; }
as_app env DATABASE_URL="$DB_URL" npm ci
as_app npm run build

echo "==> migrate"
as_app env DATABASE_URL="$DB_URL" npx prisma migrate deploy

echo "==> pm2"
# Rotate the logs. Three processes writing to six files with no rotation fills
# a disk eventually, and the first symptom is writes failing everywhere.
as_app pm2 install pm2-logrotate >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:max_size 20M      >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:retain 14         >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:compress true     >/dev/null 2>&1 || true

as_app pm2 start ecosystem.config.js --update-env || as_app pm2 reload all
as_app pm2 save
# Run as root, pm2 installs and enables the systemd unit itself.
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
# ...and verify it took. Without this unit the box reboots into nginx serving
# 502s, because nothing brings the three processes back.
if systemctl is-enabled "pm2-$APP_USER" >/dev/null 2>&1; then
  echo "   pm2-$APP_USER is enabled — the processes survive a reboot"
else
  echo "   !! pm2-$APP_USER is NOT enabled. A reboot will leave nginx serving 502s."
  echo "      Run: pm2 startup systemd -u $APP_USER --hp /home/$APP_USER"
fi

echo "==> cron: backups and the indexer monitor"
# Both are idempotent: the marker comment is what makes re-running safe.
install -m 755 "$APP_DIR/deploy/backup.sh"  /usr/local/bin/balast-backup
install -m 755 "$APP_DIR/deploy/monitor.sh" /usr/local/bin/balast-monitor
mkdir -p /var/lib/balast /var/backups/balast
chmod 700 /var/backups/balast
cat > /etc/cron.d/balast <<'CRONEOF'
# Balast — installed by deploy/bootstrap.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Is the indexer indexing, and the keeper keeping the routers? §8's P3
# failure mode: a process that dies quietly while the site looks fine — a dead
# indexer serves old numbers as though live, a dead keeper lets every router's
# TWAP lapse. (Vaults need no keeper.)
# Set ALERT_CMD in /etc/default/balast to have it reach a person.
*/5 * * * * root [ -r /etc/default/balast ] && . /etc/default/balast; /usr/local/bin/balast-monitor >/dev/null 2>&1

# Nightly dump. Local only — see the note in deploy/backup.sh about getting
# it off the box.
0 4 * * * root /usr/local/bin/balast-backup >> /var/log/balast/backup.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/balast
touch /etc/default/balast
chmod 600 /etc/default/balast
echo "   monitor every 5 min, dump at 04:00 UTC"
echo "   to be told when the indexer stalls, put ALERT_CMD in /etc/default/balast"

echo "==> nginx, HTTP only, so certbot has something to answer with"
# Only add the map if nothing else already defines $connection_upgrade —
# a duplicate makes `nginx -t` fail and would take every site on the box down
# on the next reload.
if ! grep -rqs 'connection_upgrade' /etc/nginx/conf.d /etc/nginx/nginx.conf; then
  install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
else
  echo "   \$connection_upgrade already defined elsewhere — leaving it alone"
fi
install -m 644 deploy/nginx-bootstrap.conf /etc/nginx/sites-available/balast
ln -sf /etc/nginx/sites-available/balast /etc/nginx/sites-enabled/balast
# The default site is deliberately left alone. On a server with other vhosts,
# removing it moves every unmatched request somewhere new.
nginx -t && systemctl reload nginx

echo "==> certificate"
if [[ ! -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --agree-tos --non-interactive --register-unsafely-without-email
fi

echo "==> nginx, real config with TLS"
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast
nginx -t && systemctl reload nginx

echo
echo "done — https://$DOMAIN"
echo
if grep -qE '^DATA_SOURCE=sim' "$APP_DIR/.env"; then
  echo "The site shows the SIMULATOR: generated numbers, labelled Simulated on every"
  echo "page. The indexer is syncing the real chain meanwhile. Once it has caught up,"
  echo "switch the site to real numbers with:"
  echo "  bash $APP_DIR/deploy/data-source.sh live"
else
  echo "The site shows the indexer's REAL numbers. Until the first sync reaches the"
  echo "chain head it says \"waiting for the indexer\" — that is correct, not broken."
  echo "For a full preview meanwhile, labelled Simulated:"
  echo "  bash $APP_DIR/deploy/data-source.sh sim"
fi
echo
# The processes belong to $APP_USER, so a bare `pm2 status` as root asks a
# different, empty PM2 and reports nothing running — which looks like failure.
echo "the processes run as $APP_USER, so ask pm2 as $APP_USER:"
echo "  runuser -u $APP_USER -- pm2 status"
echo "  runuser -u $APP_USER -- pm2 logs balast-indexer"
echo "  runuser -u $APP_USER -- pm2 logs balast-keeper     # idle until a router is deployed"
echo "indexer progress:          bash $APP_DIR/deploy/data-source.sh status"
echo "prove renewal works:       certbot renew --dry-run"
echo "one answer if not right:   bash $APP_DIR/deploy/doctor.sh"
