#!/usr/bin/env bash
# Обновить CRM до последнего main: bash /opt/svp-crm/deploy/update.sh
set -euo pipefail
cd /opt/svp-crm && git pull -q && npm ci --omit=dev --silent && chown -R svpcrm:svpcrm . && systemctl restart svp-crm && sleep 1 && systemctl is-active svp-crm && curl -fs localhost:3000/api/health
