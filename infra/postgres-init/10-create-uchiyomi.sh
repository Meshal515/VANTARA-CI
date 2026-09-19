#!/bin/sh
set -eu

target_db="${UCHIYOMI_DB:-uchiyomi}"
owner="${POSTGRES_USER:-vantara}"
primary_db="${POSTGRES_DB:-vantara}"

# إذا اختار المشغّل قاعدة واحدة للخدمتين، ما نحتاج إنشاء قاعدة ثانية.
if [ "$target_db" = "$primary_db" ]; then
  exit 0
fi

# سكربتات docker-entrypoint-initdb.d تعمل فقط عند إنشاء cluster جديد.
# \gexec يجعل الإنشاء idempotent حتى لو استُدعي السكربت يدويًا مرة ثانية.
psql -v ON_ERROR_STOP=1 \
  --username "$owner" \
  --dbname "$primary_db" \
  --set=target_db="$target_db" \
  --set=db_owner="$owner" <<'EOSQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'target_db', :'db_owner')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'target_db'
)
\gexec
EOSQL
