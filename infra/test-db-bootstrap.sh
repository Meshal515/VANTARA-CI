#!/bin/sh
set -eu

compose='docker compose -f infra/docker-compose.yml'
export POSTGRES_USER="${POSTGRES_USER:-vantara}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-vantara-ci-password}"
export POSTGRES_DB="${POSTGRES_DB:-vantara}"
export UCHIYOMI_DB="${UCHIYOMI_DB:-uchiyomi}"
# Required substitutions elsewhere in the compose file must parse even though
# this test only starts postgres/db-backup.
export PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost:3100}"
export SESSION_SECRET="${SESSION_SECRET:-ci-session-secret-ci-session-secret-1234}"
export VANTARA_IDENTITY_SECRET="${VANTARA_IDENTITY_SECRET:-ci-identity-secret-ci-identity-secret-12}"
export TUNNEL_TOKEN="${TUNNEL_TOKEN:-ci-unused-tunnel-token}"

cleanup() {
  $compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# A previous job must never make this test pass accidentally.
cleanup
$compose config >/dev/null
$compose up -d postgres

attempt=0
# لا تستخدم socket هنا: docker-entrypoint يشغّل temporary server على socket أثناء init
# ثم يطفئه. TCP لا يصبح جاهزًا إلا مع السيرفر النهائي الذي ستستخدمه بقية الخدمات.
until $compose exec -T postgres pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    $compose logs postgres >&2 || true
    exit 1
  fi
  sleep 1
done

# First-start init must create both databases.
for database in "$POSTGRES_DB" "$UCHIYOMI_DB"; do
  found="$($compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc \
    "SELECT 1 FROM pg_database WHERE datname = '$database'")"
  test "$found" = '1'
done

# Put independent markers in both stores so the backup/restore test proves it
# covers VANTARA and Uchiyomi rather than merely producing two archive files.
$compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE b1_restore_marker (value text PRIMARY KEY);
INSERT INTO b1_restore_marker VALUES ('vantara-before-backup');
SQL
$compose exec -T postgres psql -U "$POSTGRES_USER" -d "$UCHIYOMI_DB" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE b1_restore_marker (value text PRIMARY KEY);
INSERT INTO b1_restore_marker VALUES ('uchiyomi-before-backup');
SQL

$compose run --rm --entrypoint sh db-backup /scripts/backup-postgres.sh

# Corrupt both markers after the snapshot. A successful restore must undo this.
$compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE b1_restore_marker SET value = 'vantara-after-backup';"
$compose exec -T postgres psql -U "$POSTGRES_USER" -d "$UCHIYOMI_DB" -v ON_ERROR_STOP=1 \
  -c "UPDATE b1_restore_marker SET value = 'uchiyomi-after-backup';"

$compose run --rm -e CONFIRM_RESTORE=YES --entrypoint sh db-backup /scripts/restore-postgres.sh

vantara_value="$($compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  'SELECT value FROM b1_restore_marker')"
uchiyomi_value="$($compose exec -T postgres psql -U "$POSTGRES_USER" -d "$UCHIYOMI_DB" -Atc \
  'SELECT value FROM b1_restore_marker')"

test "$vantara_value" = 'vantara-before-backup'
test "$uchiyomi_value" = 'uchiyomi-before-backup'

printf '%s\n' 'B1 clean bootstrap + logical backup/restore: OK'
