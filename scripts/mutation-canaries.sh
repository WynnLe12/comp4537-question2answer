#!/usr/bin/env bash
# Mutation canaries: tests for the tests. Each canary plants one small, realistic bug in the Node API running
# in the api container, restarts it, and runs the parity or reliability suite that should notice. The canary
# passes only if that suite FAILS; a suite that still passes with the bug in place is blind to it.
#
# Stryker (npm run test:mutation in node-api) does this automatically for the in-process tests, but it swaps
# code inside its own sandbox, which the parity suites never reach: they talk to the api container. So these
# bugs go into the container itself. The container's own copy of each file is saved first and put back after
# every canary (and on exit, even after Ctrl-C), then the API is restarted clean.
#
# Before planting anything, each suite runs once unchanged and must pass, otherwise a failure would prove
# nothing. The suites write test users and posts to both databases, as the parity suites always do.
#
#   scripts/mutation-canaries.sh              every canary
#   scripts/mutation-canaries.sh flag         only canaries whose name contains "flag"
#   scripts/mutation-canaries.sh --list       list the canaries
#
# Run from the repository root with the stack up. Exits non-zero if any canary survives.
set -uo pipefail
cd "$(dirname "$0")/.."

# name | file under node-api/ | exact text (must appear once) | replacement | suite (jest path pattern) | the bug
# A canary must change what the API does. A change nothing can observe (dead code, or spacing in SQL) is
# an "equivalent mutant": it always survives and proves nothing, so it does not belong here.
IFS= read -r -d '' CANARIES <<'EOF'
votes-net-sum|src/repositories/votes.js|x.netvotes=a.upvotes-a.downvotes|x.netvotes=a.upvotes+a.downvotes|tests/parity/votes|net votes add the downvotes instead of subtracting them
answers-count-double|src/repositories/posts.js|'UPDATE qa_posts SET acount = ? + acount WHERE postid = ?', [increment, questionid]|'UPDATE qa_posts SET acount = ? + acount WHERE postid = ?', [increment * 2, questionid]|tests/parity/posts|a new answer adds 2 to the question's answer count
flag-hide-off-by-one|src/services/post-changes.js|if (flagcount >= Number(options.get('flagging_hide_after'))) {|if (flagcount > Number(options.get('flagging_hide_after'))) {|tests/parity/flags|a post is hidden one flag later than the hide threshold
favorite-shared-events|src/repositories/favorites.js|nouserevents) VALUES (?, ?, ?, 0)|nouserevents) VALUES (?, ?, ?, 1)|tests/parity/favorites|new favorites are stored as using the shared event stream
read-no-escaping|src/reads/execute.js|  return escape(text);|  return `'${text}'`;|tests/reliability/read-fuzz|string SQL arguments are quoted without escaping (quotes and backslashes reach MySQL raw)
EOF

if [ "${1:-}" = "--list" ]; then
  echo "$CANARIES" | while IFS='|' read -r name file _ _ suite why; do [ -n "$name" ] || continue; printf '%-24s %-28s %s\n' "$name" "$suite" "$why"; done
  exit 0
fi
selected=$(echo "$CANARIES" | grep -F -- "${1:-}" | grep -v '^$')
[ -n "$selected" ] || { echo "No canary matches '${1:-}'."; exit 1; }

WORK=$(mktemp -d)
restored=1
restore() {
  # Put back every file saved from the container, then restart the API clean.
  [ "$restored" = 1 ] && return
  for saved in "$WORK"/orig/*.js; do
    [ -e "$saved" ] || continue
    put "$saved" "$(cat "${saved%.js}.path")"
  done
  restart_api || echo "WARNING: the API did not come back healthy after restoring; run: docker compose restart api"
  restored=1
}
trap 'restore; rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM

# docker compose commands get </dev/null so they never read the canary list the main loop is reading.
put() { docker compose cp "$1" "api:/app/$2" </dev/null >/dev/null 2>&1; }
restart_api() {
  docker compose restart api </dev/null >/dev/null 2>&1 || return 1
  local id; id=$(docker compose ps -q api </dev/null)
  for _ in $(seq 1 60); do
    [ "$(docker inspect --format '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ] && return 0
    sleep 2
  done
  return 1
}

suite() {
  docker compose run --rm -T -e RELIABILITY=1 tests npx jest --runInBand "$1" </dev/null >"$2" 2>&1
}

# 1. Every suite the selected canaries rely on must pass without any bug planted.
echo "Baseline: each suite must pass unchanged"
baseline_failed=0
for s in $(echo "$selected" | cut -d'|' -f5 | sort -u); do
  if suite "$s" "$WORK/baseline.log"; then echo "  PASS  $s"
  else echo "  FAIL  $s (log below; fix this before trusting any canary)"; tail -40 "$WORK/baseline.log"; baseline_failed=1; fi
done
[ "$baseline_failed" = 0 ] || exit 1

# 2. Plant each bug in turn; the suite must now fail.
echo
echo "Canaries: each planted bug must make its suite fail"
mkdir -p "$WORK/orig"
killed=0; survived=0; broken=0; total=$(echo "$selected" | wc -l | tr -d ' ')
while IFS='|' read -r name file find replace s why; do
  key=$(echo "$file" | tr '/' '_' | sed 's/\.js$//')
  if [ ! -e "$WORK/orig/$key.js" ]; then
    docker compose cp "api:/app/$file" "$WORK/orig/$key.js" </dev/null >/dev/null 2>&1 || { echo "  ERROR $name: cannot read $file from the container"; broken=$((broken + 1)); continue; }
    echo "$file" >"$WORK/orig/$key.path"
  fi
  if ! FIND="$find" REPLACE="$replace" node -e '
      const fs = require("fs"); const [src, dst] = process.argv.slice(1);
      const text = fs.readFileSync(src, "utf8"); const { FIND, REPLACE } = process.env;
      const count = text.split(FIND).length - 1;
      if (count !== 1) { console.error(`expected the text once, found it ${count} times`); process.exit(1); }
      fs.writeFileSync(dst, text.replace(FIND, () => REPLACE));' "$WORK/orig/$key.js" "$WORK/mutant.js" </dev/null; then
    echo "  ERROR $name: the text to change is not in $file (has the code moved? update this canary)"; broken=$((broken + 1)); continue
  fi
  restored=0
  put "$WORK/mutant.js" "$file"
  if ! restart_api; then
    echo "  ERROR $name: the API did not start with this bug (the canary should be a bug, not a crash)"; broken=$((broken + 1))
  elif suite "$s" "$WORK/$name.log"; then
    echo "  SURVIVED  $name: $s still passes when $why"; survived=$((survived + 1))
  else
    echo "  KILLED    $name: $s caught it ($why)"; killed=$((killed + 1))
  fi
  put "$WORK/orig/$key.js" "$file"
done <<<"$selected"
restore

echo
echo "Killed $killed, survived $survived, errors $broken (of $total canaries)."
[ $((killed + survived + broken)) -eq "$total" ] || { echo "Not every canary ran."; exit 1; }
[ "$survived" -eq 0 ] && [ "$broken" -eq 0 ]
