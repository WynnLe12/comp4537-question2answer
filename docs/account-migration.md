# Account and profile migration

The eighth migrated slice: saving the profile, changing the password, uploading an avatar,
confirming an email address, resetting a forgotten password and unsubscribing from mailings. The
Node API checks, writes and sends the emails; PHP renders the account, confirm, forgot, reset and
unsubscribe pages. Reference behaviour: `pages/account.php`, `pages/confirm.php`,
`pages/forgot.php`, `pages/reset.php`, `pages/unsubscribe.php` and the functions they call in
`app/users-edit.php`, `app/blobs.php`, `util/image.php`, `app/emails.php` and the basic filter.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| PATCH `/api/v1/account` | any of `handle`, `email`, `messages`, `wallPosts`, `mailings` (booleans), `avatar` (`''`, `gravatar`, `uploaded`), `profile` (`{ title: value }`) | `{ user, errors }` |
| PUT `/api/v1/account/password` | `{ oldPassword, newPassword }` | `{ changed: true }` |
| PUT `/api/v1/account/avatar` | the image itself (`Content-Type: image/*`, up to 2 MB) | `{ avatar: { blobid, width, height } }` |
| POST `/api/v1/account/confirmation-email` | — | `{ sent: true }` |
| POST `/api/v1/account/confirm-email` | `{ handle, code }` | `{ confirmed: true }` |
| POST `/api/v1/account/password-reset` | `{ emailHandle }` | `{ sent: true }` |
| POST `/api/v1/account/password-reset/complete` | `{ emailHandle, code, newPassword }` | `{ user }` and a session cookie |
| POST `/api/v1/account/unsubscribe` | `{ handle, code }` when not signed in | `{ unsubscribed: true }` |

Requests need `X-Q2A-Request: 1`. Profile, password, avatar and confirmation-email need a signed-in
user; confirming, resetting and unsubscribing work from the email link without one.

Saving the profile works like the account page: fields that pass their checks are saved even when
others fail, and `errors` lists the failures (`handle`: `required`, `invalid`, `max_length`,
`blocked`, `exists`; `email`: `required`, `invalid`, `max_length`, `exists`;
`profile.<title>`: `max_length`). Fields left out keep their values; the page always sends them all.

Other errors: 401 `unauthenticated`; 403 `no_permission` (a blocked user who is not waiting for
confirmation); 400 `validation_failed` (`oldPassword: wrong`, `newPassword: too_short`); 400
`invalid_code`; 404 `user_not_found`; 403 `already_logged_in` (resetting while signed in); 400
`image_not_read`; 429 `upload_limit`; 413 `payload_too_large`; 503 `email_failed`.

## What Node reproduces

- Profile: `qa_handle_email_filter()` with the basic filter (handle characters, length,
  `block_bad_usernames` with Q2A's word matching, email validity and length, duplicates),
  `allow_change_usernames`, the messages/wall/mailings flags (only when the matching feature is on),
  the avatar choice flags, profile fields (`qa_userfields`, 8000 characters), the email confirmed
  flag cleared on a new address with a confirmation link when `confirm_user_emails` is on, and the
  user's last write.
- Password: the current password (bcrypt or the legacy salted SHA-1), the minimum length, the new
  bcrypt hash with the legacy columns cleared, and the user's other sessions ended while this one
  stays signed in (PHP clears `sessioncode` for the same reason).
- Confirmation: new 8-character codes (`qa_random_alphanum()`), the confirmation email and link,
  matching the code against the named user and then the signed-in user, setting the confirmed flag
  and clearing the must-confirm flag and the code.
- Password reset: finding the user by handle or email (`allow_login_email_only`), the reset email
  and link, checking the code, setting the password, clearing the code and signing the user in.
- Unsubscribe: the no-mailings flag, for the signed-in user or the user and code from the link.
- Avatar: the upload permission and hourly limit (counted even when the image cannot be read, as in
  PHP), shrinking to fit `avatar_store_size`, white behind transparency, JPEG quality 90, a new
  random 64-bit blob ID in `qa_blobs`, the avatar flags, and deleting the old blob.
- Email: `qa_send_notification()` and `qa_send_email()` through Q2A's SMTP options, with Q2A's own
  templates (`src/data/lang-emails.json`, exported from `qa-lang-emails.php`), the "handle,"
  greeting, `^site_title`-style substitutions and links built like `qa_path_absolute()` for every
  URL format (checked against PHP's output in `tests/fixtures/php-path-outputs.json`).

## Bridge

The writes of the account and unsubscribe pages move, unchanged, into new core functions with the
standard `qa_to_override` hook: `qa_user_save_profile()`, `qa_user_upload_avatar()`,
`qa_user_change_password()` and `qa_user_unsubscribe()` in `app/users-edit.php`.
`qa_send_new_confirm()`, `qa_complete_confirm()`, `qa_start_reset_user()` and
`qa_finish_reset_user()` already had the hook. The bridge overrides all eight, sends
`X-Q2A-Account-Backend: node-api-v1`, passes on the codes from the email links, and stores the new
session after a reset. The pages still run their own checks first so they can show their messages.

## Email in the Docker stack

`compose.yaml` adds Mailpit, and the seed points both sites' SMTP options at it, so the PHP site,
the shared UI and the API all send real email that can be read at http://localhost:8025. The PHP
image now includes GD, so avatar uploads work on the PHP site too.

## Parity tests

`node-api/tests/parity/account.test.js` (20 cases) uses the real account, confirm, forgot, reset and
unsubscribe pages on the PHP site and the shared UI, and the API, and compares outcomes, page
messages, every account column and profile field these pages write, avatar sizes and blobs, upload
limits, and the emails caught by Mailpit (subject, sender, recipient and text, with codes masked).
The codes from those emails are then used to confirm the address and reset the password.

## Known differences

- Node has no local mailer: with `smtp_active` off it sends nothing, where PHP would use `mail()`.
- The resized avatar is produced by sharp, not GD, so its bytes differ; its size, format and flags
  match. Node does not estimate PHP's memory limit (`qa_image_file_too_big()`).
- Registration through Node does not yet send a confirmation email when `confirm_user_emails` is
  on (the authentication slice predates email support); this moves with the notifications slice.
- Custom page slugs (`qa_get_request_map()`) are not applied to links in emails.
- `sessioncode` is not set by Node logins; Node's sessions live in `node_auth_sessions`.
