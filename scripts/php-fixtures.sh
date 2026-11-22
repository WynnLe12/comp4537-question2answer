#!/usr/bin/env bash
# Regenerates the fixtures that record what Q2A's own PHP helpers return, so the in-process tests can hold
# the Node ports to PHP's answers (docs/mutation-testing.md). Each generator in node-api/tests/fixtures/php-*.php
# runs in the PHP container, without a database, and its JSON lands beside it as php-<name>-outputs.json.
# Run from the repository root with the stack up.
set -euo pipefail
cd "$(dirname "$0")/.."

for generator in node-api/tests/fixtures/php-*.php; do
  name=$(basename "$generator" .php)
  docker compose cp "$generator" "php:/tmp/$name.php" >/dev/null 2>&1
  docker compose exec -T php php -d display_errors=stderr "/tmp/$name.php" 2>/dev/null </dev/null >"node-api/tests/fixtures/$name-outputs.json.tmp"
  # Fail on a PHP warning or error in the output rather than writing a broken fixture.
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "node-api/tests/fixtures/$name-outputs.json.tmp"
  mv "node-api/tests/fixtures/$name-outputs.json.tmp" "node-api/tests/fixtures/$name-outputs.json"
  echo "wrote node-api/tests/fixtures/$name-outputs.json"
done
