#!/usr/bin/env bash
#
# test-mysql.sh — run the e2e suites against a REAL MySQL (not the default
# in-memory sqljs), so the invariants that sqljs can't faithfully exercise
# (transaction/row-locking for the webhook idempotency race, FK SET NULL,
# collation on unique constraints) are proven on the real engine.
#
# Each e2e file runs against its OWN freshly-created database (they seed the
# same admin email / create overlapping rows, so they must not share one DB).
# Schema is built via DB_SYNCHRONIZE=true (dev-only; prod uses migrations).
#
# Usage:  MYSQL="/path/to/mysql" DB_USERNAME=root DB_PASSWORD= ./scripts/test-mysql.sh
# Defaults target a local root@127.0.0.1:3306 with no password.
set -euo pipefail

MYSQL="${MYSQL:-mysql}"
HOST="${DB_HOST:-127.0.0.1}"
PORT="${DB_PORT:-3306}"
USER="${DB_USERNAME:-root}"
PASS="${DB_PASSWORD:-}"

E2E_FILES=(
  tests/admin-flow.e2e.test.ts
  tests/rbac-admin.e2e.test.ts
  tests/billing.e2e.test.ts
  tests/refresh-csrf.e2e.test.ts
  tests/throttle.e2e.test.ts
)

mysql_cmd() {
  if [ -n "$PASS" ]; then "$MYSQL" -h"$HOST" -P"$PORT" -u"$USER" -p"$PASS" "$@"; \
  else "$MYSQL" -h"$HOST" -P"$PORT" -u"$USER" "$@"; fi
}

fail=0
for f in "${E2E_FILES[@]}"; do
  db="oe_e2e_$(echo "$f" | tr -c 'a-z0-9' '_')"
  echo "===== $f  (db: $db) ====="
  mysql_cmd -e "DROP DATABASE IF EXISTS \`$db\`; CREATE DATABASE \`$db\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
  if DB_DRIVER=mysql DB_HOST="$HOST" DB_PORT="$PORT" DB_USERNAME="$USER" DB_PASSWORD="$PASS" \
     DB_DATABASE="$db" DB_SYNCHRONIZE=true npx vitest run "$f"; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f FAILED"; fail=1
  fi
  mysql_cmd -e "DROP DATABASE IF EXISTS \`$db\`;"
done

if [ "$fail" -ne 0 ]; then echo "MySQL e2e: FAILURES"; exit 1; fi
echo "MySQL e2e: all suites passed"
