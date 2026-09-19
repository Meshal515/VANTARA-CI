#!/bin/sh
set -eu

backup_dir="${BACKUP_DIR:-/backups/postgres}"
primary_db="${POSTGRES_DB:-vantara}"
uchiyomi_db="${UCHIYOMI_DB:-uchiyomi}"
mkdir -p "$backup_dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tmp_dir="$backup_dir/.tmp-$stamp-$$"
mkdir -p "$tmp_dir"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

# custom format gives us pg_restore validation/selective restore and is safe for a
# running PostgreSQL instance because pg_dump takes a consistent logical snapshot.
pg_dump --format=custom --no-owner --no-acl --dbname="$primary_db" --file="$tmp_dir/vantara.dump"
pg_dump --format=custom --no-owner --no-acl --dbname="$uchiyomi_db" --file="$tmp_dir/uchiyomi.dump"

# Validate both archives before publishing them as the newest backup.
pg_restore --list "$tmp_dir/vantara.dump" >/dev/null
pg_restore --list "$tmp_dir/uchiyomi.dump" >/dev/null

final_dir="$backup_dir/$stamp"
mv "$tmp_dir" "$final_dir"
trap - EXIT INT TERM

ln -sfn "$stamp" "$backup_dir/latest"
printf '%s\n' "$final_dir"
