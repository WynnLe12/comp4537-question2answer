# Reads migration

Slices 12 and 12b. 
The data every page shows. On the shared UI (port 8081), the database
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

## Read helpers (slice 12b)

The rest of the reads pages make go through small helpers in other `db/*.php` files. Each gains the
standard `qa_to_override` hook, and the bridge sends it to the same Node endpoint by name, getting back
exactly what the PHP function returns (a list, a keyed map, one row, one value, a count or a boolean).
Node's ports are in `node-api/src/reads/helpers.js`:

- `db/users.php`: users by email or handle, handles of user IDs and back, external logins.
- `db/metas.php`: `qa_db_meta_get()` for post, user, category and tag meta (only those four tables).
- `db/cookies.php`, `db/notices.php`, `db/limits.php`: cookie checks, user notices, rate-limit counts.
- `db/votes.php`: one user's vote, a post's votes, the posts a user voted on or flagged, and the
  voters and flaggers shown to moderators.
- `db/post-update.php`: which posts are questions (closing as a duplicate) and the authors of posts.
- `db/admin.php`: the statistics page (post, user and category counts, active users, table sizes, the
  MySQL version), the approve-users list, the IP and user post lists, dependents, blob checks, and the
  category position, depth, parent and slug lookups.
- `qa-db.php`: `qa_db_list_tables()` (the plugins page).
- `db/blobs.php`, `db/cache.php`: blobs (avatars and images) and the scaled-image cache. A cache hit
  also records when it was read, as PHP does, and `qa_db_cache_set()` (storing a scaled image) goes to
  a second internal endpoint.

With the bridge on, a trace of every query PHP sends showed none left: neither while browsing every
page (signed out, signed in and as an admin, images included) nor during the whole parity suite.

## v1 contract

This endpoint is for the bridge only. It returns private columns (emails, password hashes) the
pages need, so it requires the shared `BRIDGE_SECRET` (set in `.env`) and answers 404 without it.
It is not a public API.

| Method and path | Body | Does |
| --- | --- | --- |
| POST `/api/v1/internal/reads` (header `X-Q2A-Bridge-Key`) | `{ reads: [{ name, args, count }] }`, at most 100 | Runs each named `db/selects.php` builder or read helper with PHP's arguments (`count` wraps a builder like `qa_db_selectspec_count()`) and returns `{ results }` in order |
| POST `/api/v1/internal/cache` (header `X-Q2A-Bridge-Key`) | `{ type, cacheid, content }` (content in base64) | `qa_db_cache_set()`: prunes entries unread for a day and stores the scaled image; 204 |

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
- `qa_db_apply_sub()` exactly: arguments are written into the SQL as `qa_db_argument_to_mysql()`
  writes them, so numeric `#` arguments stay unquoted with every digit (64-bit blob and cookie IDs
  included) and MySQL compares them as it does for PHP.
- PHP's argument handling, including its loose comparisons: `qa_db_qs_selectspec(..., $specialtype
  = true)` keeps `true` as the post type (since `true == 'Q'` in PHP) and so finds nothing, exactly
  as PHP does.
- The connection charset: reads use `utf8` (utf8mb3), as Q2A's `set_charset('utf8')` does, so
  `COLLATE utf8_bin` comparisons and 4-byte characters behave the same.

## Parity tests

`node-api/tests/parity/reads.test.js` (157 cases) runs 87 builder calls and 55 helper calls, with real arguments taken
from the database (a busy question, an active user, categories, a page, messages, favorites), both
ways on the same database: through PHP's own builders and `qa_db_single_select()`
(`docker/php/read-harness.php` on the shared UI, with the bridge switched off and the same bridge
key required), and through the Node endpoint. Helpers are compared as the PHP values they return. Keys, order and every byte of every value must
match. It also checks the endpoint's key and name checks, and loads the shared UI's main pages, a
question, a user, a tag and a category page, stores a scaled image through Node, plus a signed-in user's pages (account, messages,
favorites, updates, walls) and every admin page, to confirm they render from Node reads without PHP
errors. Its fixtures (categories, post meta, favorites, a notice, an external login, a cached image) are removed afterwards, since a category on
the site makes Q2A require one for every new question.

```bash
docker compose run --rm tests npx jest --runInBand tests/parity/reads.test.js
```

The other suites keep passing with every page reading through Node.

## Known differences

- Plugins' own queries stay in PHP.
- Reads inside write paths that never run on the shared UI (because the write itself moved to Node in
  an earlier slice) keep their PHP code for the reference site; Node has its own versions.
- The read harness is a Docker test fixture; it is not part of a production deployment.
