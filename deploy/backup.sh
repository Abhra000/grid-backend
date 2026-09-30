#!/bin/bash
# Nightly Postgres backup, keeps 30 days.  Cron: 30 1 * * * /opt/gridmatrix/backup.sh
set -e
source /opt/gridmatrix/api/.env
mkdir -p /opt/gridmatrix/backups
pg_dump "$DATABASE_URL" -Fc -f /opt/gridmatrix/backups/gridmatrix_$(date +%F).dump
find /opt/gridmatrix/backups -name 'gridmatrix_*.dump' -mtime +30 -delete
