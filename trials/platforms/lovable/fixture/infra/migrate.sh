#!/bin/sh
# Lovable applies a project's new Supabase migrations when its owner approves
# them. This does the same for the local Supabase: every
# supabase/migrations/*.sql file not applied yet, in name order, each in one
# transaction together with its record, then a PostgREST schema reload.
set -eu
export PGPASSWORD=shop
sql() { psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
sql -c "create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])"
for file in $(ls /migrations/*.sql 2>/dev/null | sort); do
  version=$(basename "$file" .sql)
  if [ -n "$(sql -tA -c "select 1 from supabase_migrations.schema_migrations where version = '$version'")" ]; then
    continue
  fi
  echo "Applying $version"
  sql -1 -f "$file" -c "insert into supabase_migrations.schema_migrations (version) values ('$version')"
done
sql -c "notify pgrst, 'reload schema'"
