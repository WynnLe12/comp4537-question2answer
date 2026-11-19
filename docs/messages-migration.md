# Private messages and wall posts migration

The seventh migrated slice: sending and deleting private messages, and posting on and deleting
from user walls. The Node API checks and writes; PHP renders the message page, the inbox and
outbox, and user walls. Reference behaviour: `pages/message.php`, `qa_wall_error_html()`,
`qa_wall_add_post()`, `qa_wall_delete_post()`, `qa_wall_posts_add_rules()` and `qa_pm_delete()`
in `app/messages.php`, the wall forms in `pages/user-wall.php` and `pages/user-profile.php`, and
the ajax handlers `ajax/wallpost.php`, `ajax/click-wall.php` and `ajax/click-pm.php`.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| POST `/api/v1/users/:handle/messages` | `{ content }` | 201, `{ id, to }` (`id` is `null` when message history is off) |
| DELETE `/api/v1/messages/:box/:id` | — | `{ id, box, deleted }`; `:box` is `inbox` or `outbox` |
| POST `/api/v1/users/:handle/wall` | `{ content }` | 201, `{ id }` |
| DELETE `/api/v1/wall-posts/:id` | — | `{ id, deleted }` |

Requests need `X-Q2A-Request: 1` and a signed-in user.

Errors:
- 401 `unauthenticated`.
- Messages: 404 `user_not_found` (also when private messages are switched off), 403
  `no_permission` (messaging yourself, a blocked user or IP), 403 `messages_disabled` (the
  recipient switched them off), 429 `message_limit`.
- Walls: 404 `user_not_found`, 403 `wall_blocked`, 403 `wall_must_confirm`/`wall_must_be_approved`,
  403 `no_permission` (walls switched off, level, blocked), 429 `wall_limit`.
- 400 `validation_failed` with `content: required | max_length`.
- Deleting: 404 `message_not_found` (also for a message that is not in your box), 403
  `delete_not_allowed`.

## What Node reproduces

- The message page's checks: no messages to yourself, `allow_private_messages`, the recipient's
  "no private messages" flag, the message permission and hourly limit (`max_rate_user_messages`,
  `max_rate_ip_messages`), and an empty message (PHP's `empty()`, so `"0"` counts as empty).
- `qa_wall_error_html()`: `allow_user_walls`, the "no wall posts" flag (except on your own wall),
  `permit_post_wall` and the wall limit (Q2A uses the message limits for walls too).
- Writes: the message row (only when `show_message_history` is on), the cached `wallposts` count,
  rate-limit counters and, for private messages, the user's last write, as the `qa_event_limits`
  module does (wall posts do not record one in Q2A either).
- Who may delete a wall post (`qa_wall_posts_add_rules()`): the wall's owner, anyone with both
  `permit_hide_show` and `permit_delete_hidden`, and the author while their posts are the newest
  on the wall's first page.
- Deleting a private message hides it from that box and removes it once both sides hid it.

## Bridge

The private message send in `pages/message.php` moves, unchanged, into a new core function
`qa_pm_send()` with the standard `qa_to_override` hook (its email goes in
`qa_pm_send_notification()`). `qa_wall_delete_post()` and `qa_pm_delete()` gain the hook too;
`qa_wall_add_post()` already had it. The bridge overrides all four, so the forms and the ajax
buttons go to Node, with the header `X-Q2A-Message-Backend: node-api-v1`. The pages still run
their own checks first so they can show their messages.

## Parity tests

`node-api/tests/parity/messages.test.js` (18 cases) uses the real message page, inbox and outbox
ajax buttons and wall forms (including the ajax wall delete) on the PHP site and the shared UI, and
the API, and compares outcomes, page messages, messages and their hidden flags, wall post counts,
rate limits and last writes. Cases cover sending, empty messages, messaging yourself, disabled
private messages, the limit, sending without message history, anonymous visitors, deleting from
the inbox and then the outbox, posting on walls, empty and blocked wall posts, the wall limit, and
who may delete a wall post.

## Known differences

- Characters outside the Basic Multilingual Plane (emoji, for example): `pages/message.php` and
  `pages/user-wall.php` pass the text straight to MySQL, which refuses them in the utf8mb3 columns, so
  the PHP site stops with a database error and stores nothing. Node drops those characters, as Q2A's
  `qa_remove_utf8mb4()` does for posts, and stores the rest. Pinned by
  `node-api/tests/reliability/known-differences.test.js`.
- Email: since the [notifications slice](notifications-migration.md) Node sends both the private
  message email (`emailed` in the response says whether it went out) and the wall post email.
- Characters outside the Basic Multilingual Plane are removed, since the table is utf8mb3; PHP
  would hit a database error. Content longer than the column (12000 characters) is refused.
