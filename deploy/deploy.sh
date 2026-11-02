#!/usr/bin/env bash
# Legger Foto ut på serveren. Rører ingen andre tjenester.
# Innstillingene (server, domene, e-post) står i deploy/deploy.env – kopier deploy/deploy.env.example første gang.
# Kjør: bash deploy/deploy.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF="$ROOT/deploy/deploy.env"
[ -f "$CONF" ] || { echo "Mangler $CONF – kopier deploy/deploy.env.example og fyll inn."; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
: "${DEPLOY_HOST:?Mangler DEPLOY_HOST i deploy.env}" "${DOMAIN:?Mangler DOMAIN i deploy.env}" "${ADMIN_EMAIL:?Mangler ADMIN_EMAIL i deploy.env}"
HOST="$DEPLOY_HOST"

rsync -az --delete --exclude node_modules --exclude build --exclude .svelte-kit --exclude data --exclude '.env*' \
  "$ROOT/app/" "$HOST:/opt/foto/app/"
scp -q "$ROOT/deploy/docker-compose.yml" "$HOST:/opt/foto/docker-compose.yml"
# nginx-siden legges bare inn første gang, så TLS-linjene certbot legger til ikke overskrives senere.
ssh "$HOST" 'test -e /etc/nginx/sites-available/foto.conf' || \
  scp -q "$ROOT/deploy/nginx-foto.conf" "$HOST:/etc/nginx/sites-available/foto.conf"

ssh "$HOST" "DOMAIN='$DOMAIN' ADMIN_EMAIL='$ADMIN_EMAIL' SITE_TITLE='${SITE_TITLE:-Foto}' S3_ENDPOINT='${S3_ENDPOINT:-}' bash -s" <<'REMOTE'
set -e
cd /opt/foto
# Første gang: lag .env med hemmeligheter (S3-nøklene ligger i .s3-credentials, laget ved NAS-oppsettet).
if [ ! -e .env ]; then
  umask 077
  {
    echo "SITE_TITLE=$SITE_TITLE"
    echo "SITE_TAGLINE="
    echo "ADMIN_EMAIL=$ADMIN_EMAIL"
    echo "ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d "/+=")"
    if [ -n "$S3_ENDPOINT" ]; then
      echo "STORAGE_DRIVER=s3"
      echo "S3_ENDPOINT=$S3_ENDPOINT"
      echo "S3_REGION=us-east-1"
      echo "S3_BUCKET=originaler"
      echo "S3_BACKUP_BUCKET=database"
      cat .s3-credentials
    else
      echo "STORAGE_DRIVER=local"
    fi
  } > .env
  echo "Laget /opt/foto/.env (admin-passordet står der)."
fi
mkdir -p data && chown 1000:1000 data
docker compose up -d --build 2>&1 | tail -2
ln -sf /etc/nginx/sites-available/foto.conf /etc/nginx/sites-enabled/foto.conf
nginx -t 2>&1 | tail -1 && systemctl reload nginx
sleep 3
echo "Foto: $(curl -s 127.0.0.1:8792/health) lagring: $(curl -s 127.0.0.1:8792/health/storage)"
# TLS første gang, når DNS peker hit.
if [ ! -e "/etc/letsencrypt/live/$DOMAIN" ] && hostname -I | tr ' ' '\n' | grep -qxF "$(dig +short "$DOMAIN" | tail -1)"; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect -m "$ADMIN_EMAIL" 2>&1 | tail -2
fi
REMOTE
