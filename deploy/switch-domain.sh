#!/usr/bin/env bash
#
# Move a running box onto tidewell.live (§19). Run once, as root:
#
#   bash /var/www/balast/deploy/switch-domain.sh
#
# The order is the whole point. nginx will not start with a certificate that
# does not exist, and a certificate cannot be issued until nginx answers the
# ACME challenge for the new name on port 80. So:
#
#   1. check the new name actually points at this box (fail before touching nginx)
#   2. answer the challenge for it over plain HTTP, beside the running site
#   3. get the certificate
#   4. only then install the real config, test it, and reload
#
# Safe to rerun: an existing certificate is kept, and nothing is installed that
# `nginx -t` rejects. The old domain keeps working throughout and ends up
# redirecting to the new one.
set -euo pipefail

DOMAIN=tidewell.live
APP_DIR=/var/www/balast
WEBROOT=/var/www/certbot

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
cd "$APP_DIR"

echo "==> 1/4  does $DOMAIN point here?"
# The box's public address, as the outside world sees it, and what DNS says.
here=$(curl -4 -fsS --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
for name in "$DOMAIN" "www.$DOMAIN"; do
  got=$(getent ahostsv4 "$name" | awk 'NR==1{print $1}')
  if [[ "$got" != "$here" ]]; then
    echo "    $name resolves to '${got:-nothing}', but this box is $here."
    echo "    Fix the A record (or wait for DNS to propagate) and run this again."
    exit 1
  fi
  echo "    $name -> $got  ok"
done

echo "==> 2/4  answer the ACME challenge for $DOMAIN on port 80"
mkdir -p "$WEBROOT"
cat > /etc/nginx/sites-available/tidewell-acme <<CONF
# Temporary: lets certbot prove control of $DOMAIN. Removed by switch-domain.sh.
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN www.$DOMAIN;
    location ^~ /.well-known/acme-challenge/ { root $WEBROOT; default_type "text/plain"; }
    location / { return 404; }
}
CONF
ln -sf /etc/nginx/sites-available/tidewell-acme /etc/nginx/sites-enabled/tidewell-acme
nginx -t && systemctl reload nginx

echo "==> 3/4  certificate"
if [[ -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  echo "    already have one — kept"
else
  certbot certonly --webroot -w "$WEBROOT" \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --agree-tos --non-interactive --register-unsafely-without-email
fi
rm -f /etc/nginx/sites-enabled/tidewell-acme /etc/nginx/sites-available/tidewell-acme

echo "==> 4/4  the real config"
if ! grep -rqs 'connection_upgrade' /etc/nginx/conf.d /etc/nginx/nginx.conf; then
  install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
fi
cp -a /etc/nginx/sites-available/balast /etc/nginx/sites-available/balast.before-tidewell 2>/dev/null || true
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast
ln -sf /etc/nginx/sites-available/balast /etc/nginx/sites-enabled/balast
# balast.xyz over HTTPS redirects too, if its certificate is still on the box.
if [[ -s /etc/letsencrypt/live/balast.xyz/fullchain.pem ]]; then
  install -m 644 deploy/nginx-legacy.conf /etc/nginx/sites-available/balast-legacy
  ln -sf /etc/nginx/sites-available/balast-legacy /etc/nginx/sites-enabled/balast-legacy
fi
if ! nginx -t; then
  echo "    nginx rejected the new config — putting the old one back"
  cp -a /etc/nginx/sites-available/balast.before-tidewell /etc/nginx/sites-available/balast
  rm -f /etc/nginx/sites-enabled/balast-legacy
  nginx -t && systemctl reload nginx
  exit 1
fi
systemctl reload nginx

echo
echo "done — https://$DOMAIN"
curl -fsS -o /dev/null -w "    https://$DOMAIN answered %{http_code}\n" "https://$DOMAIN/pools" || true
echo "prove the renewal path works:  certbot renew --dry-run"
