#!/usr/bin/env bash
#
# Nightly backup: one custom-format pg_dump plus a tarball of the uploads
# volume, named with a UTC timestamp (DEV_PLAN §2.15).
#
# Cron (03:15 UTC daily):
#   15 3 * * * /opt/supproject/scripts/backup.sh >> /var/log/supproject-backup.log 2>&1
#
# Restore:
#   # database (stop api first so nothing writes mid-restore)
#   docker compose stop api
#   docker compose exec -T db pg_restore --clean --if-exists \
#     -U "$POSTGRES_USER" -d "$POSTGRES_DB" < globie-<stamp>.dump
#   docker compose start api
#
#   # uploads
#   docker compose exec -T api tar xzf - -C /app/var/media < uploads-<stamp>.tar.gz
#
#   # sanity check afterwards
#   curl -fsS https://keeperapi.globie.ai/api/health

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/supproject}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "[backup] dumping database"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$BACKUP_DIR/globie-$STAMP.dump"

echo "[backup] archiving uploads"
docker compose run --rm -T --no-deps api \
  tar czf - -C /app/var/media . \
  > "$BACKUP_DIR/uploads-$STAMP.tar.gz"

chmod 600 "$BACKUP_DIR/globie-$STAMP.dump" "$BACKUP_DIR/uploads-$STAMP.tar.gz"

echo "[backup] pruning files older than ${KEEP_DAYS} days"
find "$BACKUP_DIR" -maxdepth 1 -type f \
  \( -name 'globie-*.dump' -o -name 'uploads-*.tar.gz' \) \
  -mtime "+${KEEP_DAYS}" -delete

ls -lh "$BACKUP_DIR/globie-$STAMP.dump" "$BACKUP_DIR/uploads-$STAMP.tar.gz"
