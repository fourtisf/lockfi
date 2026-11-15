#!/usr/bin/env bash
#
# Set one variable in the app's .env, without opening an editor.
#
#   ./deploy/set-env.sh USDG_ADDRESS 0xabc...
#   ./deploy/set-env.sh START_BLOCK 1234567
#   ./deploy/set-env.sh KEEPER_PRIVATE_KEY - # prompts; the key never touches argv or history
#   ./deploy/set-env.sh                      # show the current values
#
# Replaces the line if the key is already there, appends it if not, and leaves
# every other line — including the generated database password — untouched.
#
# A blind `sed -i` over a secrets file is how a password gets mangled by a
# stray character in the replacement, so the value is written with awk and a
# literal assignment rather than substituted into a pattern.
set -euo pipefail

ENV_FILE=${ENV_FILE:-/var/www/balast/.env}
APP_USER=${APP_USER:-balast}

[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE"; exit 1; }

# No arguments: show what is set, with secrets masked.
if [[ $# -eq 0 ]]; then
  echo "$ENV_FILE:"
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ -z "$line" ]] && continue
    key=${line%%=*}
    value=${line#*=}
    case "$key" in
      *URL*|*PASS*|*SECRET*|*KEY*) value="<set, ${#value} chars>" ;;
      *) [[ -z "$value" ]] && value="<empty>" ;;
    esac
    printf '  %-22s %s\n' "$key" "$value"
  done < "$ENV_FILE"
  exit 0
fi

[[ $# -eq 2 ]] || { echo "usage: $0 KEY VALUE   (VALUE - to type it, hidden)"; exit 1; }
KEY=$1
VALUE=$2

# "-" reads the value from the terminal without echoing it. A private key on
# the command line is in the shell history and, while this runs, in `ps`.
if [[ "$VALUE" == "-" ]]; then
  read -r -s -p "$KEY: " VALUE
  echo
fi

[[ "$KEY" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "not a variable name: $KEY"; exit 1; }

# An address typo is silent and expensive: a wrong USDG makes every USD figure
# on the site zero, and nothing downstream can tell that from a quiet market.
if [[ "$KEY" == *_ADDRESS || "$KEY" == V3_FACTORY ]]; then
  if [[ ! "$VALUE" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "$KEY must be a 40-hex-digit address starting 0x, got: $VALUE"
    exit 1
  fi
  VALUE=$(printf '%s' "$VALUE" | tr 'A-F' 'a-f')
fi

TMP=$(mktemp)
# Copy every line except the one being replaced, then append the new one.
# awk rather than sed: the value goes in as a literal, so a character that
# would mean something in a sed replacement cannot corrupt the file.
awk -v key="$KEY" 'index($0, key "=") != 1' "$ENV_FILE" > "$TMP"
printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"

# Preserve ownership and mode: this file holds the database password.
chown --reference="$ENV_FILE" "$TMP" 2>/dev/null || chown "$APP_USER:$APP_USER" "$TMP"
chmod --reference="$ENV_FILE" "$TMP" 2>/dev/null || chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"

echo "set $KEY"
echo
echo "the processes read .env at startup, so this takes effect on:"
case "$KEY" in
  KEEPER_PRIVATE_KEY)
    echo "  runuser -u $APP_USER -- pm2 restart balast-keeper --update-env" ;;
  *)
    echo "  runuser -u $APP_USER -- pm2 restart balast-indexer balast-api --update-env" ;;
esac
