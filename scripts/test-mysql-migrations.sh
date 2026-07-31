#!/usr/bin/env bash
#
# test-mysql-migrations.sh — prove the TypeORM MIGRATIONS (not DB_SYNCHRONIZE)
# apply cleanly on a REAL MySQL, including the additive Phase-3
# AddFeatureGroupKind migration, and that re-running is a safe no-op.
#
# The main test:mysql suite builds schema with DB_SYNCHRONIZE=true (fast, from
# entities). That never exercises the migration files themselves — so a broken
# migration could ship undetected. This script runs the real migration path:
#   fresh DB → migration:run → assert features.group + features.kind exist
#             → migration:run again → assert the migrations table did NOT grow
#               (idempotent no-op), checked via INFORMATION_SCHEMA, not log text.
#
# Wired as `npm run test:mysql:migrations`. SKIPS (exit 0) if no MySQL is
# reachable, so it's safe in CI without a DB. Assumptions when a DB IS present:
#   • a `mysql` client on PATH (override with MYSQL=/path/to/mysql)
#   • it and the Node `mysql2` driver reach the SAME server — this script
#     forces both onto TCP 127.0.0.1:$PORT (a preflight asserts the CLI connects
#     over TCP, not a local socket, so the two never diverge).
#   • Usage: MYSQL=/path/to/mysql DB_USERNAME=root DB_PASSWORD= ./scripts/test-mysql-migrations.sh
set -euo pipefail

MYSQL="${MYSQL:-mysql}"
HOST="${DB_HOST:-127.0.0.1}"
PORT="${DB_PORT:-3306}"
USER="${DB_USERNAME:-root}"
PASS="${DB_PASSWORD:-}"
DB="${DB_DATABASE:-oe_migtest}"

# Force TCP (--protocol=TCP) so the CLI hits the same 127.0.0.1:$PORT the mysql2
# driver uses — never a local socket that could be a different server.
mysql_cmd() {
  if [ -n "$PASS" ]; then "$MYSQL" --protocol=TCP -h"$HOST" -P"$PORT" -u"$USER" -p"$PASS" "$@"; \
  else "$MYSQL" --protocol=TCP -h"$HOST" -P"$PORT" -u"$USER" "$@"; fi
}

# Preflight: if MySQL isn't reachable, SKIP (not fail) — CI without a DB is fine.
if ! mysql_cmd -e "SELECT 1;" >/dev/null 2>&1; then
  echo "SKIP: no MySQL reachable at ${USER}@${HOST}:${PORT} (set DB_* / MYSQL to run this check)."
  exit 0
fi

# Always drop the test DB on ANY exit path (success, assertion failure, crash).
cleanup() { mysql_cmd -e "DROP DATABASE IF EXISTS \`$DB\`;" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "===== migration run on real MySQL (db: $DB) ====="
mysql_cmd -e "DROP DATABASE IF EXISTS \`$DB\`; CREATE DATABASE \`$DB\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# Build once, then run the compiled data-source through the TypeORM CLI.
npm run build >/dev/null

run_migrations() {
  DB_DRIVER=mysql DB_HOST="$HOST" DB_PORT="$PORT" DB_USERNAME="$USER" DB_PASSWORD="$PASS" \
    DB_DATABASE="$DB" npx typeorm migration:run -d dist/database/data-source.js
}

# Count applied migrations from the migrations table (authoritative — not logs).
applied_count() {
  mysql_cmd -N -e "SELECT COUNT(*) FROM \`$DB\`.\`migrations\`;" 2>/dev/null || echo 0
}

echo "--- first migration:run ---"
run_migrations
first_count=$(applied_count)
echo "  applied migrations after first run: $first_count"
if [ "$first_count" -lt 2 ]; then
  echo "  ✗ expected >=2 migrations applied, found $first_count"; exit 1
fi

echo "--- assert features.group and features.kind columns exist ---"
cols=$(mysql_cmd -N -e "SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS \
  WHERE TABLE_SCHEMA='$DB' AND TABLE_NAME='features' AND COLUMN_NAME IN ('group','kind');")
if [ "$cols" != "2" ]; then
  echo "  ✗ expected 2 columns (group,kind), found $cols"; exit 1
fi
echo "  ✓ features.group + features.kind present"

echo "--- second migration:run (must be a no-op) ---"
run_migrations >/dev/null
second_count=$(applied_count)
echo "  applied migrations after second run: $second_count"
# Idempotent iff the migrations table did not grow — a structural fact, robust to
# any change in TypeORM's log wording. (Audit M4.)
if [ "$second_count" != "$first_count" ]; then
  echo "  ✗ re-run applied more migrations ($first_count → $second_count) — not idempotent"; exit 1
fi
echo "  ✓ re-run is a no-op (migrations table unchanged at $second_count)"

echo "MySQL migrations: OK (fresh run applies group/kind; re-run no-op)"
