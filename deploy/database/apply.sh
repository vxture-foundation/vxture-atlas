#!/usr/bin/env bash
# Clean-baseline DDL applier. Run ONLY by the db-init workflow - never by the
# container entrypoint (the entrypoint must never migrate). Applies the
# three-part baseline then any numbered increments, in order, fail-fast.
set -euo pipefail

DDL_DIR="$(cd "$(dirname "$0")/ddl" && pwd)"
DB_URL="${DATABASE_URL:?DATABASE_URL is required}"

for f in 00_baseline.sql 97_service_role.sql 98_column_locks.sql; do
  echo "applying ${f}"
  psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${DDL_DIR}/${f}"
done

shopt -s nullglob
for f in "${DDL_DIR}"/incr/*.sql; do
  echo "applying incr $(basename "${f}")"
  psql "${DB_URL}" -v ON_ERROR_STOP=1 -f "${f}"
done

echo "DDL applied."
