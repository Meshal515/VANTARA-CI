#!/bin/sh
set -eu

if [ "${CONFIRM_RESTORE:-}" != "YES" ]; then
  echo 'Refusing restore: set CONFIRM_RESTORE=YES' >&2
  exit 2
fi

backup_dir="${BACKUP_DIR:-/backups/postgres}"
restore_from="${RESTORE_FROM:-$backup_dir/latest}"
primary_db="${POSTGRES_DB:-vantara}"
uchiyomi_db="${UCHIYOMI_DB:-uchiyomi}"

vantara_dump="$restore_from/vantara.dump"
uchiyomi_dump="$restore_from/uchiyomi.dump"

for dump in "$vantara_dump" "$uchiyomi_dump"; do
  if [ ! -f "$dump" ]; then
    echo "Missing backup archive: $dump" >&2
    exit 3
  fi
  pg_restore --list "$dump" >/dev/null
done

# ‏`--single-transaction` و`--exit-on-error` ليسا تزيينًا:
#
# افتراض `pg_restore` هو **المواصلة بعد الخطأ** («exit on error, default is to
# continue» في `--help`)، ثم طباعة عدد الأخطاء في النهاية. ومع `--clean` هذا
# يعني أن استعادة تتعثّر في منتصفها تكون قد **أسقطت** الجداول القديمة وبنت
# نصف الجديدة، ثم يطبع السطر الأخير «Restore completed» — نجاح كاذب على مسار
# التعافي من كارثة، وهو أسوأ مكان يحدث فيه.
#
# داخل transaction واحدة: إمّا تُستعاد القاعدة كاملة، أو تبقى كما كانت.
pg_restore --single-transaction --exit-on-error --clean --if-exists \
  --no-owner --no-acl --dbname="$primary_db" "$vantara_dump"
pg_restore --single-transaction --exit-on-error --clean --if-exists \
  --no-owner --no-acl --dbname="$uchiyomi_db" "$uchiyomi_dump"

echo 'Restore completed for VANTARA and Uchiyomi databases.'
