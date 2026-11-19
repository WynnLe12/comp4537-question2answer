# Moderation and user administration migration

The tenth migrated slice: what moderators and admins do to users and posts. Users are approved,
blocked, edited, promoted, hidden and deleted from the user's profile page and the approve-users
page; posts are approved, rejected, hidden, reshown, deleted and cleared of flags from the admin
moderate, flagged and hidden pages. Reference behaviour: `pages/user-profile.php`,
`qa_admin_single_click()` in `app/admin.php`, `qa_set_user_level()`, `qa_set_user_blocked()` and
`qa_delete_user()` in `app/users-edit.php`, and `qa_post_set_status()`/`qa_post_delete()` in
`app/posts.php`.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| PATCH `/api/v1/users/:handle` | any of `email`, `profile` (`{ title: value }`), `removeAvatar` | `{ handle, errors }` |
| PUT `/api/v1/users/:handle/level` | `{ level }` and/or `{ categoryLevels: [{ categoryid, level }] }` | `{ handle, level }` |
| POST `/api/v1/users/:handle/approve` | — | `{ handle, level }` |
| PUT `/api/v1/users/:handle/block`, DELETE to unblock | — | `{ handle, blocked }` |
| POST `/api/v1/users/:handle/hide-posts` | — | `{ hidden: [postids] }` |
| DELETE `/api/v1/users/:handle` | — | `{ handle, deleted: true }` |

Post moderation uses the post endpoints from the [post changes](post-changes-migration.md) and
[flags](flags-migration.md) slices (`POST /api/v1/posts/:id/status`, `DELETE /api/v1/posts/:id`,
`DELETE /api/v1/posts/:id/flags`); the admin pages call the same functions as the question page.

Errors: 401 `unauthenticated`; 404 `user_not_found`; 403 `level_not_allowed`, `block_not_allowed`,
`unblock_not_allowed`, `edit_not_allowed`, `hide_not_allowed`, `delete_not_allowed`; 400
`invalid_input`. Admin edits save the fields that pass their checks and list the rest in `errors`
(`email`: `required`, `invalid`, `max_length`, `exists`; `profile.<title>`: `max_length`).

## What Node reproduces

- The profile page's rules: nobody changes themselves, or a user at or above their own level
  (counting category levels) unless they are a super admin, nor anything while blocked themselves;
  super admins assign any level, admins up to moderator, moderators up to expert, and a blocked user
  only up to editor; only admins edit email and profile fields; block, unblock, hide all and delete
  need a user below moderator, and the page offers hide all and delete only for blocked users;
  deleting needs an admin and hiding all needs `permit_hide_show`.
- The approve-users page's rules: moderators approve users up to "approved" and block anyone.
- `qa_set_user_level()` and `qa_set_user_blocked()` as these pages call them (with the old level or
  the handle), so the count of users awaiting approval is recounted, the deprecated must-approve
  flag cleared on approval, the approved user emailed, and the actor's last write recorded.
- Category levels (`qa_userlevels`), constrained to the level the actor may assign.
- Admin edits: the email (with the confirmed flag cleared), profile fields, and removing the avatar
  and its blob.
- Deleting a user: the account, points row, avatar blob, profile, favorites (theirs and of them),
  update stream, votes, flags and limits; the votes and flags they gave are recounted with their
  posts' points; the cached totals; and the user's Node sessions.
- Hiding all posts: each visible or queued post hidden or rejected with the same status change as
  the question page's buttons.

## Bridge

`qa_set_user_level()` and `qa_set_user_blocked()` gain the standard `qa_to_override` hook
(`qa_delete_user()` already had it). The profile page's admin edit writes move, unchanged, into new
core functions `qa_user_admin_save()` and `qa_set_user_category_levels()`. The bridge overrides all
five and sends `X-Q2A-Admin-Backend: node-api-v1`. Post actions on the admin pages and the hide-all
button already reach Node through the post status and delete overrides.

## Parity tests

`node-api/tests/parity/admin.test.js` (13 cases) presses the real buttons on the profile, approve,
moderate, flagged and hidden pages on the PHP site and the shared UI, calls the API, and compares
outcomes, page messages, users (level, flags, email, profile fields, category levels), whether the
count of users awaiting approval is right, every post value the other suites check, and the emails.

## Known differences

- PHP's profile page accepts a crafted "hide all" or "delete" request for a user who is not blocked,
  although it never shows those buttons then; Node refuses it.
- Hiding all posts skips any post the question page would not offer to hide or reject (for example
  an answer already hidden with its question), where PHP would set it again.
