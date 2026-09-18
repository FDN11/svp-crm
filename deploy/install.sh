#!/usr/bin/env bash
# Установка СВП CRM на чистый Ubuntu 24.04 (VPS Beget). Запускать от root:
#   bash install.sh crm.svpbrand.com admin@svpbrand.com
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
DOMAIN="${1:?домен, например crm.svpbrand.com}"; EMAIL="${2:?e-mail для Lets Encrypt}"
APP_DIR=/opt/svp-crm; DATA_DIR=/var/lib/svp-crm; REPO=https://github.com/FDN11/svp-crm.git

apt-get update -qq && apt-get install -y -qq curl git nginx certbot python3-certbot-nginx sqlite3 ufw >/dev/null
# Node 22 LTS (нужен node:sqlite)
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* && "$(node -v)" != v2[3-9]* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && apt-get install -y -qq nodejs >/dev/null
fi
id -u svpcrm &>/dev/null || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin svpcrm
mkdir -p "$DATA_DIR/backups" && chown -R svpcrm:svpcrm "$DATA_DIR"

git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull -q; else git clone -q "$REPO" "$APP_DIR"; fi
cd "$APP_DIR" && npm ci --omit=dev --silent && chown -R svpcrm:svpcrm "$APP_DIR"

# окружение: пароль администратора и токен вебхуков создаются один раз
ENV=/etc/svp-crm.env
if [ ! -f "$ENV" ]; then
  ADMIN_PASS=$(openssl rand -hex 8)
  cat > "$ENV" <<ENVEOF
PORT=3000
CRM_DB=$DATA_DIR/crm.db
CRM_USER=admin
CRM_PASS=$ADMIN_PASS
CRM_ADMIN_NAME=Администратор
CRM_WEBHOOK_TOKEN=$(openssl rand -hex 16)
NODE_ENV=production
ENVEOF
  chmod 600 "$ENV"
  echo "==> первый вход: admin / $ADMIN_PASS  (сохранён в $ENV)"
fi

cp "$APP_DIR/deploy/svp-crm.service" /etc/systemd/system/
systemctl daemon-reload && systemctl enable -q svp-crm && systemctl restart svp-crm

# nginx + https
sed "s/__DOMAIN__/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/svp-crm
ln -sf /etc/nginx/sites-available/svp-crm /etc/nginx/sites-enabled/svp-crm
rm -f /etc/nginx/sites-enabled/default; nginx -t -q && systemctl reload nginx
certbot --nginx -n --agree-tos -m "$EMAIL" -d "$DOMAIN" --redirect || echo "!! certbot не смог выдать сертификат — проверьте, что A-запись $DOMAIN указывает на этот сервер, и повторите: certbot --nginx -d $DOMAIN"

# бэкапы: ежедневно в 03:15, хранить 30 дней
cp "$APP_DIR/deploy/backup.sh" /usr/local/bin/svp-crm-backup && chmod +x /usr/local/bin/svp-crm-backup
echo "15 3 * * * root /usr/local/bin/svp-crm-backup" > /etc/cron.d/svp-crm-backup

ufw allow OpenSSH >/dev/null; ufw allow 'Nginx Full' >/dev/null; ufw --force enable >/dev/null
systemctl is-active svp-crm && echo "==> СВП CRM: https://$DOMAIN"
