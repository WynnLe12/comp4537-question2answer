# Voting migration

The second migrated slice. Voting on questions, answers and comments is decided and written
by the Node API; PHP still renders pages and the ajax vote buttons. Reference behaviour:
`qa_vote_error_html()` and `qa_vote_set()` in `qa-include/app/votes.php`, plus the vote branch
of `qa-include/plugins/qa-event-limits.php`.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| PUT `/api/v1/posts/:postid/vote` | `{ "vote": -1 \| 0 \| 1 }` | 200, `{ vote, post: { id, upvotes, downvotes, netvotes } }` |

Like the other v1 POST routes, it needs JSON and `X-Q2A-Request: 1`, and the session cookie
(now scoped to `/api/v1` so it reaches every v1 resource). Errors are checked in PHP's order:

| Status | `error.code` | PHP message shown by the bridge |
| --- | --- | --- |
| 400 | `invalid_input` | — (the bridge clamps values the way PHP does) |
| 404 | `post_not_found` | `main/vote_not_allowed` |
| 403 | `vote_disabled_hidden`, `vote_disabled_queued`, `vote_not_allowed` | matching `main/...` string |
| 401 | `unauthenticated` | `main/vote_must_login` with login links |
| 403 | `vote_must_confirm`, `vote_down_must_confirm` | matching `main/...` string with links |
| 429 | `vote_limit` | `main/vote_limit` |
| 403 | `no_permission` (level, blocked user, blocked IP, approval) | `users/no_permission` |

## What Node reproduces

- Permission checks: `voting_on_qs/as/cs`, own-post rule, `permit_vote_q`/`permit_vote_a`
  (PHP also uses `permit_vote_a` for comments), `permit_vote_down`, points-based permits,
  category-specific user levels, blocked users, `block_ips_write`, email confirmation and the
  hourly per-user/per-IP vote limits by database time.
- Writes, in PHP's order: `qa_uservotes`, post vote counts, answer `amaxvote` and the
  `cache_unupaqcount` total (including the full recount for questions with several answers),
  voter and author `qa_userpoints` (the same generated SQL as `qa_db_points_update_ifuser()`),
  question hotness, `qa_userlimits`/`qa_iplimits`, and `qa_users.written`/`writeip`.
- Option values come from `qa_options`, falling back to Q2A's defaults.
  `node-api/src/data/option-defaults.json` is generated from Q2A's `$fixed_defaults`.

## Bridge

`qa-plugin/node-auth-bridge/overrides.php` overrides `qa_vote_error_html()` and `qa_vote_set()`.
Both PHP vote paths (the ajax request and the no-JavaScript form handled in `app/page.php`) call
the check and then the setter. Node checks and writes in one request, so the check override
sends the vote and the setter skips the repeat. Responses carry `X-Q2A-Vote-Backend: node-api-v1`.
The bridge forwards the browser's address in `X-Forwarded-For`. The API believes it only from
addresses matching `TRUST_PROXY` (`uniquelocal` in Compose), so recorded IPs and IP rate limits
match PHP's `REMOTE_ADDR`. This also corrects `loginip`/`createip` for bridge logins and registrations.

## Parity tests

`node-api/tests/parity/votes.test.js` runs every case three times: the PHP reference through
its real ajax endpoint and form codes, the shared UI on port 8081 through the bridge, and the
Node API directly. Each run has its own users and identical fixture posts. After each step, the
test compares acceptance, the user-visible message (PHP and the bridged UI), and the database
values above. Totals that depend on each database's history (rate-limit counters, cached
counts) are compared as changes. The cases cover:
- up, down, changed, removed, repeated and out-of-range votes
- answers, including the amaxvote recount
- hidden, queued, missing and own posts, and disabled comment voting
- anonymous users, rate limits, blocked users, and a separate down-vote permission
- the recorded IP address

Fixture posts are inserted with SQL because post creation is not migrated yet. The fixture
helper then recounts `cache_unupaqcount`, as Q2A does when it creates questions.

## Known differences

- Node runs each vote in one transaction. PHP autocommits each statement, so after a database
  error PHP can leave a partial vote, while Node leaves nothing.
- PHP writes a missing option's default into `qa_options` the first time it reads it. Node only
  reads defaults. PHP still writes them on the shared site whenever it renders a page.
- Of the event modules, only the built-in `qa_event_limits` behaviour is reproduced. Other
  `process_event` plugins (such as the optional event logger) are not called for Node votes.
- A post ID with no row is rejected by PHP's own post lookup in the bridge, before Node is called.
- Votes need a signed-in user. PHP would try to store an anonymous vote if an administrator
  allowed it; Node returns 401.
- The Node MySQL pool reports changed rows rather than matched rows (`-FOUND_ROWS`), as mysqli does.
