# Mutation testing

The parity and reliability suites check the Node API. Mutation testing checks those suites: it plants a
small bug in the Node code (a `>=` becomes `>`, a `-` becomes `+`, a condition becomes `true`, a line is
removed), runs the tests, and expects them to **fail**. A planted bug the tests catch is *killed*; one they
still pass with *survived*, and marks behaviour no test actually checks, however high the line coverage.

There are two layers, because the suites run in two different places.

## 1. Stryker, over the in-process suite

```bash
cd node-api
npm run test:mutation                          # every file under src/
npx stryker run --mutate src/q2a/points.js     # one file
npx stryker run --mutate 'src/q2a/*.js'        # one folder
```

[Stryker](https://stryker-mutator.io) generates the bugs itself, one per mutant, and runs only the tests that
cover the changed line (`coverageAnalysis: perTest`). Settings are in `node-api/stryker.config.mjs`. The
report is printed and written to `node-api/reports/mutation/index.html`. Open that file in a browser to see
every surviving mutant beside the source line it changed.

The report gives each file a **mutation score**: killed ÷ (killed + survived + not covered). Read the
survivors more than the score:

- **A survivor on real behaviour** (a count, a permission check, a limit) means a test is missing or its
  assertion is too loose. Add or tighten a test.
- **An equivalent mutant** changes the code without changing what it does. For example, changing
  `i < list.length` to `i <= list.length` in a loop that stops early anyway. Nothing can kill these;
  leave them.
- **A survivor in SQL text or PHP-ported string building** (most of `repositories/`, `q2a/points.js`,
  `reads/`) is usually *not* a gap. The in-process tests replace the database, so they cannot see what the
  SQL does. The parity suites check those statements against real MySQL and PHP, and the canaries below
  check that the parity suites would notice.

Stryker cannot run the parity or reliability suites. It changes the code inside its own sandbox copy,
while those suites send requests to the API container, which never sees the change.

## 2. Mutation canaries, over the parity and reliability suites

```bash
scripts/mutation-canaries.sh              # every canary
scripts/mutation-canaries.sh flag         # only canaries whose name contains "flag"
scripts/mutation-canaries.sh --list
```

Each canary is one realistic bug, written into the **running api container**: the script copies the
container's file out, makes one exact text change, copies it back and restarts the API. It then runs the
suite that ought to notice the bug, and the canary passes only if that suite fails. The original file is
put back after every canary, and again on exit, even after Ctrl-C.

Before planting anything, every suite the canaries use runs once unchanged and must pass. Otherwise a
failure later would prove nothing.

| Canary | Bug planted | Suite that must fail |
| --- | --- | --- |
| `votes-net-sum` | net votes add the downvotes instead of subtracting them | `parity/votes` |
| `answers-count-double` | a new answer adds 2 to the question's answer count | `parity/posts` |
| `flag-hide-off-by-one` | a post is hidden one flag after the hide threshold | `parity/flags` |
| `favorite-shared-events` | new favorites are stored as using the shared event stream | `parity/favorites` |
| `read-no-escaping` | string SQL arguments are quoted without escaping (quotes and backslashes reach MySQL raw) | `reliability/read-fuzz` |

To add a canary, add a line to the list at the top of `scripts/mutation-canaries.sh`:
`name|file|exact text|replacement|suite|description`. The text must appear exactly once in the file, or
the script reports an error rather than guessing. If a refactor moves the code, the canary reports an
error, which tells you to update it.

A canary has to change what the API does. Two early candidates were dropped because nothing could ever
catch them (they were *equivalent mutants*). One changed `flagtohide` in `services/post-common.js`, but
Node never reads that field: it uses `postRules()` only to allow or refuse actions, and the shared UI's
"flag and hide" label comes from PHP's own `question-view.php`. That canary showed the field was dead
code, so it has since been removed from Node. The other added spaces around numeric SQL arguments, which
MySQL ignores. A bug that stops the API from starting counts as an error, not a
kill: a canary should be a wrong answer, not a crash.

The suites write test users and posts to both databases, as the parity suites always do. Run
`scripts/fresh-databases.sh` afterwards if you want the clean seed back.

## Closing the gaps: tests checked against PHP itself

A survivor means no test pins that behaviour down. For the helpers ported from PHP (`src/q2a/`), the
expected answers come from PHP, not from Node, so the tests check that Node matches PHP and not just that
it keeps doing what it does today:

```bash
scripts/php-fixtures.sh      # stack up; rewrites node-api/tests/fixtures/php-*-outputs.json
```

Each generator, `node-api/tests/fixtures/php-<name>.php`, runs in the PHP container. It calls Q2A's own
functions over a grid of inputs and writes the answers to `php-<name>-outputs.json`. No database is
involved: options go straight into Q2A's option cache, the logged-in user into its user cache, and the
SQL that `qa_db_points_update_ifuser()` would run is captured through Q2A's `qa_db_query_raw()` override.
If PHP prints a warning or error into the output, the script refuses to write the fixture.

| Generator | PHP functions | Node test |
| --- | --- | --- |
| `php-permissions.php` | `qa_permit_value_error`, `qa_permit_error`, `qa_limits_calc_remaining`, `qa_block_ip_match`, `qa_is_ip_blocked`, `qa_user_permit_error`, the category-level functions, `qa_user_moderation_reason`, `qa_post_is_by_user` (about 15,000 cases) | `tests/integration/permissions.test.js` |
| `php-helpers.php` | PHP's number and boolean conversions, `qa_db_points_calculations` and the points statement, `qa_default_option`, `qa_path`, `qa_q_request`, `qa_q_path`, the text helpers (`qa_string_to_words`, block words, `qa_slugify`, tags, `qa_email_validate` with 921 addresses), `qa_combine_notify_email`, `strtr`; `qa_default_option` for every option an admin can reset (225 options, 18 site and option combinations) | `tests/integration/q2a-helpers.test.js`, `tests/integration/site-admin-defaults.test.js` |

Each Node test checks one function's whole table of cases and lists every case where Node differs.
Running one test per function, not one per case, also keeps Stryker fast (about 30 tests per mutant, not
1,700).

The rest of the in-process code is tested directly:
- `tests/integration/routes.test.js`: every v1 route, with recording services.
- `tests/integration/app.test.js`: CORS, security headers, body limits, errors, 404, health check.
- `tests/integration/mail-notify.test.js`: every notification email, with a recording SMTP transport.
- `tests/integration/services-*.test.js`, `ai-services.test.js`, `site-admin-defaults.test.js`: the
  services, driven directly with a recording fake repository (`tests/integration/fake-repository.js`),
  and the AI provider with `fetch` replaced. The parity suites have already checked these services
  against PHP, so these tests pin each of their rules and writes.

### What the PHP comparison found

Places where Node did not match PHP. All were fixed, and the parity suites still pass:

- **Email validation** (`text.emailValidate`, also used for registration in `services/auth.js`). Node
  approximated PHP's `FILTER_VALIDATE_EMAIL` with the `validator` package, and they disagreed on 4 of the
  first 30 addresses. Node accepted `user@127.0.0.1` and `user@exämple.com`, which PHP rejects. Node
  refused `a@b.c` and `user@[IPv6:::1]`, which PHP accepts. Node now runs PHP's own pattern on the UTF-8
  bytes, and matches PHP on all 921 addresses in the fixture.
- **Old vote-points options** (`options.js`). Node's "is the old value numeric?" check used JavaScript's
  `Number()`, which accepts `'0x10'` and `'Infinity'`. PHP's `is_numeric()` rejects both. Node now uses
  a PHP-exact `phpIsNumeric()`, shared with the reads.
- **URLs** (`paths.js`). PHP tests the request and anchor with `empty()`, and `empty('0')` is true. PHP
  also writes parameter values with `(string)`, so `false` becomes `''` and `true` becomes `'1'`. Node now
  does both.
- **Resetting admin options** (`services/site-admin.js`). Found by comparing every reset default with
  PHP's `qa_default_option()`:
  - The vote-points fallback had the same `Number()` bug as `options.js`.
  - The default terms and sidebar texts did not HTML-escape the language string the way
    `qa_lang_html_sub()` does, so "Terms & Conditions" was saved with a bare `&`.
  - Single quotes in the site title were not escaped, while PHP 8's `htmlspecialchars()` escapes them.
  - The default `from_email` dropped a first host part such as `1e3`, which PHP's `is_numeric()` counts
    as a number and keeps. The same check in `options.js` is fixed too.
- **Dead code.** `flagtohide` in `services/post-common.js` was computed but never read (found by a
  canary; removed).

Two differences were left on purpose. They only appear for inputs no request can produce, and the
permissions test skips them with the reason written in it. Both come from PHP 8 comparing `null` loosely:
a user whose points are `null` (Node loads points with `COALESCE(points, 0)`), and a user whose level is
`null` (`qa_users.level` is `NOT NULL`).

## Results

First full runs, November 2026.

**Canaries: 5 of 5 killed.** Each suite passed unchanged first, then failed with its bug planted.

**Stryker: 12,326 mutants over `src/`, 22 minutes at concurrency 2.**

| | Mutants | Killed | Survived | No coverage |
| --- | --- | --- | --- | --- |
| All of `src/` | 12,326 | 1,796 (14.6%) | 1,019 | 9,511 |
| Only lines the in-process tests reach | 2,815 | 1,796 (63.8%) | 1,019 | |

The low overall score is expected, and the "no coverage" count shows why. Most of it is in code that only
the parity suites exercise:

| Folder | Mutants | Score | Survived | No coverage |
| --- | --- | --- | --- | --- |
| `src/http` | 92 | 72% | 24 | 2 |
| `src/q2a` | 1,467 | 46% | 437 | 359 |
| `src/routes` | 479 | 45% | 82 | 182 |
| `src/app.js` | 155 | 41% | 70 | 21 |
| `src/services` | 6,753 | 11% | 365 | 5,632 |
| `src/repositories` | 1,390 | 2% | 7 | 1,361 |
| `src/reads` | 1,988 | 0% | 34 | 1,954 |

`reads/`, `repositories/` and most of `services/` (`posts.js`, `post-changes.js`, `account.js`,
`recalc.js`, `uploads.js`) have no in-process tests at all; the parity and reliability suites cover them,
and the canaries check that those suites notice bugs there. The places to look for missing tests are the
**survivors** in code the in-process tests do reach: `q2a/` (permissions, points, text and path helpers,
437 survivors), `app.js` and `routes/`. The HTML report lists each one beside its line.

Stryker also reported 44 errors: mutants that made the code fail to load. They count towards neither
side of the score.

### After the new tests

Stryker rerun over the code the new tests target (`src/q2a`, `src/app.js`, `src/http`, `src/routes`),
15 minutes:

| | Score before | Score after | Survived before | Survived after |
| --- | --- | --- | --- | --- |
| `src/http` | 72% | 98% | 24 | 2 |
| `src/q2a` | 46% | 90% | 437 | 131 |
| `src/routes` | 45% | 70% | 82 | 54 |
| `src/app.js` | 41% | 95% | 70 | 7 |
| **Together** | | **87%** | **613** | **194** |

`points.js`, `auth.js`, `messages.js`, `favorites.js` and the site-admin routes now kill every mutant.
Most of the routes' remaining survivors are in `internal.js` and `uploads.js`. Those routes are now
reached by a test that only checks they are mounted. Their behaviour is covered by the parity suites
(reads, uploads), not by in-process tests.

Many of the remaining survivors are equivalent mutants. For example, dropping `^` or `$` from a pattern
that starts with a greedy `(.*)`, or an IPv4 fast path that gives the same answer as the general path.
Nothing can kill those.

### The services

Stryker over the services that have in-process tests, before and after the service tests:

| | Survived before | Survived after | Score on code the tests reach, after |
| --- | --- | --- | --- |
| `auth.js` | 56 | 14 | 94% |
| `votes.js` | 50 | 4 | 98% |
| `favorites.js` | 9 | 0 | 100% |
| `messages.js` | 31 | 6 | 97% |
| `user-admin.js` | 31 | 11 | 97% |
| `site-admin.js` | 72 | 25 | 93% |
| `ai.js` | 26 | 4 | 97% |
| `aiProvider.js` | 65 | 4 | 98% |
| `post-common.js` | 21 | 21 | 62% |
| **Together** | **361** | **89** | **95%** (68% before) |

Not done: `post-common.js`. Its survivors are constants (the field limits and the event codes) used by
the post services, which only the parity suites exercise. The categories, pages, widgets and user-fields
parts of `site-admin.js` are also left to the parity suites (the "no coverage" mutants).
