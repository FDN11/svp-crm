#!/usr/bin/env bash
# Ночная копия базы (через SQLite backup API — безопасно при WAL) + вложения. Хранение 30 дней.
# Если задан S3 (переменные в /etc/svp-crm-backup.env: S3_ENDPOINT, S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) — копия уходит и туда.
set -euo pipefail
DATA=/var/lib/svp-crm; OUT=$DATA/backups; TS=$(date +%Y%m%d-%H%M)
mkdir -p "$OUT"
sqlite3 "$DATA/crm.db" ".backup '$OUT/crm-$TS.db'"
gzip -f "$OUT/crm-$TS.db"
[ -d "$DATA/files" ] && tar -czf "$OUT/files-$TS.tgz" -C "$DATA" files
find "$OUT" -type f -mtime +30 -delete
if [ -f /etc/svp-crm-backup.env ]; then
  set -a; . /etc/svp-crm-backup.env; set +a
  command -v aws >/dev/null || (apt-get install -y -qq awscli >/dev/null)
  aws --endpoint-url "$S3_ENDPOINT" s3 cp "$OUT/crm-$TS.db.gz" "s3://$S3_BUCKET/svp-crm/" --only-show-errors
fi
echo "backup ok: crm-$TS.db.gz"
