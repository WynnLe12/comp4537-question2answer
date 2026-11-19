# Reads migration

The twelfth migrated slice: the data every page shows. On the shared UI (port 8081), the database
reads Q2A's pages make through `db/selects.php` run in the Node API. PHP still builds and renders
the pages from the results. Reference behaviour: every builder in `qa-include/db/selects.php`,
with `qa_db_single_select()`, `qa_db_multi_select()`, `qa_db_post_select()` and
`qa_db_selectspec_count()` in `qa-db.php` and `db/selects.php`.

## How it works

Q2A pages ask for data with *selectspecs*: a builder such as `qa_db_qs_selectspec()` returns the
columns, source SQL and arguments, and `qa_db_select_with_pending()` runs the page's specs together
through `qa_db_multi_select()`. Every page goes through these builders, so moving them moves the
reads of every page. The page controllers do not change.

- Each builder gains the standard `qa_to_override` hook. The bridge overrides it to return only the
  builder's name and arguments (`array('node_read' => ...)`) in place of the SQL.
- The bridge also overrides `qa_db_single_select()`, `qa_db_multi_select()` and
  `qa_db_selectspec_count()`. One page's reads go to Node in one request; a spec that is not a
  Node read (a plugin's own spec, say) still runs through PHP.
- Node (`node-api/src/reads/selects.js`) ports each builder: the same SQL, columns, arguments,
  limits and sort keys. `node-api/src/reads/execute.js` ports `qa_db_apply_sub()` (`$` and `#`
  become bound parameters with PHP's quoting) and `qa_db_post_select()` (array keys, array values,
  `single`, `sortasc`/`sortdesc` and the `_order_` column).
- `qa_preload_options()` used its own two queries for the options and the database time. They move
  into two new builders, `qa_db_options_selectspec()` and `qa_db_time_selectspec()`, so options
  come from Node too.

- The builders and `qa_db_post_select()` load a few files as they run (`app/updates.php`,
  `app/users.php`, `util/string.php`, `util/sort.php`), and some pages rely on that: the message page
  calls `qa_sort_by()` without loading `util/sort.php` itself. The bridge loads the same files.

Responses that used Node reads carry `X-Q2A-Read-Backend: node-api-v1`.

## v1 contract

This endpoint is for the bridge only. It returns private columns (emails, password hashes) the
pages need, so it requires the shared `BRIDGE_SECRET` (set in `.env`) and answers 404 without it.
It is not a public API.

| Method and path | Body | Does |
| --- | --- | --- |
| POST `/api/v1/internal/reads` (header `X-Q2A-Bridge-Key`) | `{ reads: [{ name, args, count }] }`, at most 100 | Runs each named `db/selects.php` builder with PHP's arguments (`count` wraps it like `qa_db_selectspec_count()`) and returns `{ results }` in order |

Each result is `{ single: true, value }` or `{ single: false, entries: [[key, row], ...] }`.
Entries keep PHP's array order, which the `sortasc`/`sortdesc` keys decide. Values are the raw text
MySQL returns, as PHP's mysqli gives them (numbers stay strings), and binary columns (IP addresses)
come as `{ b64 }`. Unknown builder names or bad arguments are refused with 400 `invalid_input`.

## What Node reproduces

- All 58 builders the pages use: question lists (recent, hot, votes, answers, views, unanswered,
  by IP, by category, by tag, by user, flagged, edited), full posts and their children, parents,
  duplicates, closing posts, post meta, related questions and search, categories and their
  navigation, custom pages and widgets, popular tags, users (accounts, profiles, points, ranks,
  levels, notices, top and newest, blocked, by level), messages and walls, favorites and update
  streams, rate limits, options and the database time.
- PHP's argument handling, including its loose comparisons: `qa_db_qs_selectspec(..., $specialtype
  = true)` keeps `true` as the post type (since `true == 'Q'` in PHP) and so finds nothing, exactly
  as PHP does.
- The connection charset: reads use `utf8` (utf8mb3), as Q2A's `set_charset('utf8')` does, so
  `COLLATE utf8_bin` comparisons and 4-byte characters behave the same.

## Parity tests

`node-api/tests/parity/reads.test.js` (101 cases) runs 87 builder calls, with real arguments taken
from the database (a busy question, an active user, categories, a page, messages, favorites), both
ways on the same database: through PHP's own builders and `qa_db_single_select()`
(`docker/php/read-harness.php` on the shared UI, with the bridge switched off and the same bridge
key required), and through the Node endpoint. Keys, order and every byte of every value must
match. It also checks the endpoint's key and name checks, and loads the shared UI's main pages, a
question, a user, a tag and a category page, plus a signed-in user's pages (account, messages,
favorites, updates, walls) and every admin page, to confirm they render from Node reads without PHP
errors. Its fixtures (categories, post meta, favorites) are removed afterwards, since a category on
the site makes Q2A require one for every new question.

```bash
docker compose run --rm tests npx jest --runInBand tests/parity/reads.test.js
```

The other suites keep passing with every page reading through Node.

## Known differences

- Reads made through the other `db/*.php` helpers still run in PHP; slice 12b moves them. They are:
  the admin statistics counts (`qa_db_count_*`, table sizes, the MySQL version), the unapproved
  users list and the IP and user post lists in `db/admin.php`; user lookups by handle, email or ID
  (`db/users.php`); post, user and category meta (`qa_db_meta_get()`); blobs (avatars and uploaded
  images); the page cache; cookie checks; user notices; rate-limit counts (`qa_db_limits_get()`);
  and single vote and flag lookups in `db/votes.php`.
- Plugins' own queries stay in PHP.
- The read harness is a Docker test fixture; it is not part of a production deployment.
