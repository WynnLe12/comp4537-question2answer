# Flags migration

The fifth migrated slice: flagging a post, taking the flag back, and clearing every flag on a
post, including hiding a post once it has enough flags. The Node API checks and writes; PHP
renders the question page and its buttons. Reference behaviour: `qa_flag_error_html()`,
`qa_flag_set_tohide()`, `qa_flag_clear()` and `qa_flags_clear_all()` in `app/votes.php`, the
flag buttons in `pages/question-submit.php` (`qa_page_q_single_click_q/a/c`), the flag rules of
`qa_page_q_post_rules()` and the clear-flags button of the admin pages (`qa_admin_single_click()`).

## v1 contract

| Method and path | Does | Success |
| --- | --- | --- |
| PUT `/api/v1/posts/:id/flag` | Flag a question, answer or comment; hides it when it reaches `flagging_hide_after` | `{ id, flagcount, type }` (`type` ends in `_HIDDEN` when the flag hid it) |
| DELETE `/api/v1/posts/:id/flag` | Take back your own flag | `{ id, flagcount }` |
| DELETE `/api/v1/posts/:id/flags` | Clear every flag on the post | `{ id, flagcount: 0 }` |

Requests need `X-Q2A-Request: 1` and a signed-in user (the session cookie).

Errors: 404 `post_not_found`; 403 `flag_not_allowed`, `unflag_not_allowed` and
`clearflags_not_allowed` when the page would not offer the button (flagging switched off, your
own post, a hidden or queued post, a post you already flagged, no `permit_flag`, no flag of yours
to take back, too few flags or no `permit_hide_show`); 401 `unauthenticated`, 403
`flag_must_confirm` or `no_permission`, and 429 `flag_limit` from the flag permission and hourly
limits (`max_rate_user_flags`, `max_rate_ip_flags`).

## What Node reproduces

- The button rules (`flagbutton`, `unflaggable`, `clearflaggable`) with the viewer's own flag, and
  the checks of `qa_flag_error_html()`.
- The flag in `qa_uservotes`, the post's `flagcount`, the `cache_flaggedcount` total (changed by
  one per flag set or taken back, and by the number of flags cleared, exactly as Q2A does), the
  flag rate limits and the user's last write (`written`, `writeip`).
- Hiding: when a flag brings the post to `flagging_hide_after`, Node hides it in the same
  transaction as a system action, with the post as it was before the flag, as the page does. That
  runs the same status change as the hide button: cached counts, points, the word index, the
  selected answer and update streams.
- Clearing flags is accepted for the question page's button and for the admin flagged-posts page,
  which only requires `permit_hide_show`.

## Bridge

The four flag functions already carry Q2A's `qa_to_override` hook, so no core file changes.
The bridge overrides `qa_flag_set_tohide()`, `qa_flag_clear()` and `qa_flags_clear_all()` to call
Node, so the question page buttons, their ajax versions and the admin pages' clear-flags button
all go to Node. `qa_flag_set_tohide()` returns `false` because Node has already hidden the post
when needed. The page still runs `qa_flag_error_html()` first so it can show its own message; Node
checks everything again.

## Parity tests

`node-api/tests/parity/flags.test.js` (14 cases) presses the real flag, unflag and clear-flags
buttons on the PHP site and the shared UI, calls the API, and compares outcomes, page messages,
every flag and vote row on the tracked posts, flag counts, cached totals, rate limits, last writes,
points and update streams. Cases: flagging, flagging twice, own posts, anonymous visitors,
unflagging, unflagging without a flag, the hourly limit, clearing with and without permission,
and questions, answers and comments hidden by the flag that reaches the threshold.

## Known differences

- Email notifications to admins about flagged posts (`qa_event_notify`, `flagging_notify_first`
  and `flagging_notify_every`) are not sent yet; that is the notifications slice.
