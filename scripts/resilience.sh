#!/usr/bin/env bash
# Resilience: stops the Node API under the running shared UI (8081) and checks that the UI fails cleanly
# (the bridge's error instead of a page built from missing data), that nothing is written while Node is
# away (the shared UI sends no SQL of its own, so every Q2A table keeps the same checksum, even when a
# form is submitted), that the PHP reference site (8080) is unaffected, and that everything works again
# once Node is back. Run from the repository root, with the stack up. Exits non-zero on any failure.
set -uo pipefail
cd "$(dirname "$0")/.."

UI=http://localhost:8081
PHP=http://localhost:8080
JAR=$(mktemp)
trap 'rm -f "$JAR"; docker compose start api >/dev/null 2>&1' EXIT
failures=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; failures=$((failures + 1)); }
# The security code of the first form with one (attribute order varies between Q2A's forms).
code() { grep -o '<input[^>]*name="code"[^>]*>' | head -1 | sed -n 's/.*value="\([^"]*\)".*/\1/p'; }
# Every Q2A table's checksum on the shared UI's database (Node's own tables and the image cache aside).
checksums() {
  docker compose exec -T node-db sh -c 'mysql -uq2a -p"$MYSQL_PASSWORD" q2a -N -e "SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA=\"q2a\" AND TABLE_NAME LIKE \"qa\\_%\" AND TABLE_NAME<>\"qa_cache\"" | tr "," "\n" | while read -r t; do mysql -uq2a -p"$MYSQL_PASSWORD" q2a -N -e "CHECKSUM TABLE \`$t\`"; done' 2>/dev/null
}

# Signed in on the shared UI, with an ask form ready to submit.
login_code=$(curl -s -c "$JAR" -b "$JAR" "$UI/index.php?qa=login" | code)
curl -s -o /dev/null -c "$JAR" -b "$JAR" --data-urlencode emailhandle=alice --data-urlencode 'password=Password123!' --data-urlencode "code=$login_code" -d 'remember=1&dologin=1' "$UI/index.php?qa=login"
ask_code=$(curl -s -c "$JAR" -b "$JAR" "$UI/index.php?qa=ask" | code)
[ -n "$ask_code" ] && pass "signed in on the shared UI with an ask form" || fail "could not sign in on the shared UI"

before=$(checksums)
docker compose stop api >/dev/null 2>&1
echo "      (Node API stopped)"

for path in "" "questions" "user/alice" "1" "admin"; do
  body=$(curl -s -b "$JAR" "$UI/index.php?qa=$path")
  if grep -q "Node could not" <<<"$body" && ! grep -q 'class="qa-q-list-item' <<<"$body"; then
    pass "page '$path' fails with the bridge's error while Node is down"
  else
    fail "page '$path' did not fail cleanly while Node is down"
  fi
done
curl -s -o /dev/null -b "$JAR" --data-urlencode "title=Resilience question while the API is down $$" \
  --data-urlencode 'content=This must not be saved anywhere because Node is not running.' \
  -d "tags=resilience&editor=&code=$ask_code&doask=1" "$UI/index.php?qa=ask"
[ "$(checksums)" = "$before" ] && pass "nothing was written while Node was down (form submitted, every table unchanged)" || fail "the database changed while Node was down"
curl -s "$PHP/index.php?qa=questions" | grep -q 'class="qa-q-list-item' && pass "the PHP reference site is unaffected" || fail "the PHP reference site broke"

docker compose start api >/dev/null 2>&1
docker compose up -d --wait api >/dev/null 2>&1
echo "      (Node API started again)"

headers=$(curl -s -D - -o /dev/null -b "$JAR" "$UI/index.php?qa=questions")
grep -qi "^x-q2a-read-backend: node-api-v1" <<<"$headers" && pass "pages read from Node again" || fail "pages did not recover"
ask_code=$(curl -s -c "$JAR" -b "$JAR" "$UI/index.php?qa=ask" | code)
status=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" --data-urlencode "title=Resilience question after the API came back $$" \
  --data-urlencode 'content=Node is back, so this question is saved as usual.' -d "tags=resilience&editor=&code=$ask_code&doask=1" "$UI/index.php?qa=ask")
[ "$status" = "302" ] && pass "writes work again (question saved)" || fail "could not post after Node came back (HTTP $status)"

echo
[ "$failures" -eq 0 ] && echo "Resilience: all checks passed." || echo "Resilience: $failures check(s) failed."
exit $((failures > 0))
