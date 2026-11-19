# Reliability testing

The slice parity suites (`node-api/tests/parity`) check hand-picked scenarios, each comparing the rows it
expects to change. The reliability suites (`node-api/tests/reliability`) go further: long random histories,
whole-database comparison, rendered pages, an independent check of every cached count, contention, hostile
read arguments and the Node API going away. They take longer, so they run on their own:

```bash
scripts/reliability.sh                                   # everything, in order (about 10 minutes)
FUZZ_SEED=42 FUZZ_STEPS=300 scripts/reliability.sh differential   # replay or lengthen one random run
FUZZ_SEED=7 FUZZ_READS=800 scripts/reliability.sh read-fuzz
scripts/resilience.sh                                    # just the Node-down check (stack must be up)
```

`scripts/reliability.sh` first resets both development databases to the same fresh seed
(`scripts/fresh-databases.sh`); anything else in them is lost.

## The suites

| Suite | What it does | What must hold |
| --- | --- | --- |
| `differential.test.js` | A seeded random sequence of mixed actions (ask, answer, comment, vote, flag, select, close/reopen, edit, hide/reshow/delete, favorites, wall posts, private messages; signed in, anonymous and as an admin; including invalid input) runs in lockstep on the PHP site and the shared UI, from identical databases | Every action gets the same answer on both sites; every 10 actions and at the end every Q2A table holds the same rows; the invariants hold (Node breaks none PHP keeps); every kind of page renders the same HTML for the same viewer (signed out, signed in, admin) |
| `concurrency.test.js` | Twelve users act on the same posts at once through Node: votes, vote changes, answers, flags (up to the hide threshold), favorites, and a mixed storm with comments and answer selection | No request fails, counts are exact, and no invariant is newly broken |
| `read-fuzz.test.js` | Every builder and read helper call from the read parity suite, with one argument swapped for a hostile value of its kind (quotes, backslashes, LIKE wildcards, SQL fragments, emoji, NUL, padded or malformed numbers, 64-bit IDs, empty lists) | PHP's own code (the read harness) and Node return the same bytes, or both refuse |
| `known-differences.test.js` | Pins down the deliberate differences | They stay as documented |
| `scripts/resilience.sh` | Stops the Node API under the running shared UI, loads pages and submits a form, then starts it again | Pages fail with the bridge's error, nothing is written (every table's checksum unchanged), the PHP site is unaffected, and pages and writes recover |

A random run prints its seed; the same seed replays the same actions exactly, and a failure prints the last
actions taken.

## How the comparison works (`db-state.js`)

- **Same start.** Both databases are seeded by the same `docker/php/seed.php`, so auto-increment IDs line
  up. The seed's post and event times are then set to the same values on both sides, and each random
  action starts on a fresh second on each site: Q2A trims event streams by time (everything at or before
  the 6th newest event of a question goes), so events written in the same second are trimmed together, and
  the two sites must group their events into seconds the same way.
- **Housekeeping applied.** Q2A copies a question's events into every follower's stream but trims only
  one follower's stream, picked at random (Node does the same), so before each comparison both sides'
  user streams are trimmed fully by Q2A's own rule (`trimEventStreams()`): the state housekeeping heads
  for, and the same on both sides.
- **Normalised.** Times are compared as set or not; random 64-bit IDs (visitor cookies, blobs) become
  labels by first appearance; password hashes and codes are masked; hotness is compared within a tiny
  relative tolerance (it is built from creation times). Options are compared where both sides have a row,
  since Q2A stores an option's default the first time any page reads it.
- **Invariants.** Answer counts, best-answer votes, up/down/net votes, flags, title/content/tag word counts,
  tag counts, category question counts, the site-wide counts, selected answers belonging to their
  question, closing posts existing, parents existing, answers hanging off questions, the search index only
  holding visible posts, and favorites and votes pointing at existing posts. Each follows Q2A's own
  update or recount function. Both sides are checked; only a violation Node has and PHP does not is a
  migration bug.

## What these suites found and what changed

- **Node could hang under load.** Posting and post changes looked up the signed-in user inside their
  transaction, taking a second pooled connection while holding one; ten simultaneous answers, comments or
  flags took every connection and waited on each other for ever. The user is now looked up before the
  transaction (`withIdentity()` in `services/post-common.js`), and `context()` refuses to run without it.
- **Deadlocks surfaced as errors.** Simultaneous votes lock posts and votes in different orders, and
  InnoDB aborted some transactions (503s). Transactions are now retried, as MySQL advises, up to five
  times on a deadlock or lock wait timeout (`repositories/shared.js`), each attempt starting clean.
- **A race in the unupvoted-questions count.** Votes on two answers of one question both decided from the
  same old `amaxvote`; the question row is now locked for the decision (`repositories/votes.js`).
- **Emails without a sender on a fresh site.** Node read options without Q2A's computed defaults, so
  until some PHP page had stored `from_email`, Node's emails had no From address (the long-lived test
  databases hid this). Node now computes `from_email`, `mailing_from_email`, `mailing_from_name`,
  `mailing_subject` and `mailing_body` as `qa_default_option()` does (`q2a/options.js`); for `from_email`
  it uses the host in `site_url`, since it does not see the browser's request.
- **Read argument edge cases.** Node now follows PHP exactly for the count limits builders take
  (`min($count, MAX)` under PHP 8's comparison rules, keeping the argument's own digits), for PHP's
  truthiness of `'0'` (`qa_db_list_tables()`, `qa_db_count_posts()`), and for `inet_pton()` refusing a
  NUL byte.
- **Two deliberate differences, now documented and pinned:** emoji in private messages and wall posts
  (PHP's pages fail, Node drops the characters as Q2A does for posts; see
  [messages notes](messages-migration.md)), and login/registration IP limits (Node keeps them in memory;
  see [authentication notes](auth-migration.md)), which the database comparison reports rather than
  compares.
- The test drivers now recognise Q2A's error pages (which answer HTTP 200), and the read fixtures make
  their own 64-bit blob and cookie instead of relying on earlier test data.

The suites put back every option they change, and `scripts/reliability.sh` resets both databases again
when it finishes, so the parity suites and the demo start from the clean seed afterwards.

## Upstream behaviour the invariants report but do not fail on

Q2A 1.8 itself lets `cache_flaggedcount` drift: every flag adds one, even on an already flagged post. Node
copies this, so the Node-only checks (concurrency) leave that count out, and the differential suite only
reports it when both sides agree on it.
