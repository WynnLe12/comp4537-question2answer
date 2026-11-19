#!/usr/bin/env bash
# Resets both development databases to the same fresh seed, so the PHP site (8080) and the shared UI
# (8081) start from identical data with identical IDs. Used by the reliability suites
# (scripts/reliability.sh); everything else in the databases is lost. Run from the repository root.
set -euo pipefail
cd "$(dirname "$0")/.."

for db in php-db node-db; do
  # DROP DATABASE keeps the q2a user's database-level grant, so the new database is usable at once.
  docker compose exec -T "$db" sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS q2a; CREATE DATABASE q2a CHARACTER SET utf8mb4;"' 2>/dev/null
done
docker compose run --rm seed-php >/dev/null 2>&1
docker compose run --rm seed-node >/dev/null 2>&1
# Open connections lost their database with the drop, so restart what keeps them.
docker compose restart api >/dev/null 2>&1
docker compose up -d --wait api php migrated-ui >/dev/null 2>&1
echo "Both databases reset to the same fresh seed."
