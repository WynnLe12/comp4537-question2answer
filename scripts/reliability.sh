#!/usr/bin/env bash
# The reliability suites (node-api/tests/reliability, docs/reliability-testing.md). Resets both databases to
# the same fresh seed, then runs, in order:
#   1. differential       random actions in lockstep on the PHP site and the shared UI (needs the fresh seed)
#   2. concurrency, known-differences, read-fuzz
#   3. scripts/resilience.sh (stops and restarts the Node API)
# With an argument, resets and runs only the suites whose file names match it (resilience excluded).
# Settings pass through the environment:
#   FUZZ_SEED    replay a random run (differential and read-fuzz print theirs)
#   FUZZ_STEPS   actions per differential run (default 150)
#   FUZZ_READS   reads per read-fuzz run (default 300)
# Run from the repository root:  scripts/reliability.sh   |   FUZZ_SEED=42 scripts/reliability.sh differential
set -uo pipefail
cd "$(dirname "$0")/.."

suite() {
  docker compose run --rm -e RELIABILITY=1 -e FUZZ_SEED -e FUZZ_STEPS -e FUZZ_DIFF_EVERY -e FUZZ_READS tests \
    npx jest --runInBand "tests/reliability/.*($1)"
}

scripts/fresh-databases.sh || exit 1
if [ $# -gt 0 ]; then
  suite "$1"
  result=$?
  scripts/fresh-databases.sh || result=1
  exit $result
fi
status=0
suite 'differential' || status=1
suite 'concurrency|known-differences|read-fuzz' || status=1
scripts/resilience.sh || status=1
# Leave both databases clean (the same fresh seed) for the parity suites and the demo.
scripts/fresh-databases.sh || status=1
echo
[ "$status" -eq 0 ] && echo "Reliability suites: all passed." || echo "Reliability suites: failures above."
exit "$status"
