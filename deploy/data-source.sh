#!/usr/bin/env bash
#
# Choose what the site shows, and rebuild so it takes effect.
#
#   bash /var/www/balast/deploy/data-source.sh live   # the indexer's numbers
#   bash /var/www/balast/deploy/data-source.sh sim    # the simulator, labelled Simulated
#
# DATA_SOURCE is inlined when the site is BUILT (next.config.mjs), so editing
# .env and restarting changes nothing. That is the trap this exists to remove:
# it writes .env, rebuilds, and reloads balast-web. The API and the indexer are
# not touched — they run, and keep syncing, in either mode.
#
# --no-build writes .env only; bootstrap.sh uses it because it builds next.
set -euo pipefail

APP_USER=balast
APP_DIR=/var/www/balast
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
want=${1:-}
case "$want" in
  live|sim) ;;
  *) echo "usage: $0 live|sim [--no-build]"; exit 1 ;;
esac

# One way to edit .env: set-env.sh keeps every other line, the database
# password included, byte-identical.
ENV_FILE="$APP_DIR/.env" APP_USER="$APP_USER" bash "$HERE/set-env.sh" DATA_SOURCE "$want" >/dev/null
echo "==> .env: DATA_SOURCE=$want"

[[ "${2:-}" == --no-build ]] && exit 0

echo "==> rebuilding, because DATA_SOURCE is fixed at build time"
cd "$APP_DIR"
# env -u: a DATA_SOURCE left in this shell would outrank .env in the build.
runuser -u "$APP_USER" -- env -u DATA_SOURCE npm run build
runuser -u "$APP_USER" -- pm2 startOrReload ecosystem.config.js --only balast-web
runuser -u "$APP_USER" -- pm2 save >/dev/null

if [[ "$want" == sim ]]; then
  echo "done — the site shows the simulator, labelled Simulated on every page"
else
  echo "done — the site shows the indexer's numbers"
  echo "it says \"waiting for the indexer\" until the first sync has data:"
  echo "  curl -s localhost:3001/api/health"
fi
