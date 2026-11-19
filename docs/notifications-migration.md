# Email notifications migration

The ninth migrated slice: every email Q2A sends because something happened. Node now sends the
emails of the `qa_event_notify` module for the changes it makes, the welcome email on registration,
the private message email and the feedback form. Reference behaviour:
`qa-include/plugins/qa-event-notify.php`, `qa_create_new_user()` in `app/users-edit.php`,
`qa_pm_send_notification()` in `app/messages.php` and `pages/feedback.php`.

## What Node sends

| When | To | Q2A event |
| --- | --- | --- |
| A question is asked | the admin, if `notify_admin_q_post` | `q_post` |
| A question is answered | the question's author, if they asked for notifications | `a_post` |
| A comment is added | the parent's author, then earlier commenters on the same post, each address once | `c_post` |
| A post waits for moderation, or an edit sends it back | the admin, if `moderate_notify_admin` | `*_queue`, `*_requeue` |
| A moderator approves a post | as if it had just been posted (author, commenters, admin) | delayed `*_post` |
| An answer is selected | the answer's author | `a_select` |
| A post is flagged | the admin, on flag `flagging_notify_first` and every `flagging_notify_every` after | `*_flag` |
| A wall post is added | the wall's owner | `u_wall_post` |
| Someone registers | the new user (welcome, with a confirmation link when confirmations are on), and the admin if `register_notify_admin` | `u_register` |
| A private message is sent | the recipient | — |
| The feedback form is sent | the site's feedback address, replying to the visitor | `feedback` |

The emails use Q2A's own templates and substitutions, links with the question's slug built like
`qa_q_path()` (`qa_slugify()` and `qa_block_words_replace()`, checked against PHP's output in
`tests/fixtures/php-slug-outputs.json`), censoring with `block_bad_words` where Q2A censors, and
PHPMailer's line endings.

Emails are built inside the change's transaction and sent once it commits, so a rolled-back change
sends nothing. As in PHP, a failed email does not undo the change; the private message response
says whether its email went out (`emailed`) and the feedback form fails with 503 `email_failed`.

`notify.js` also holds `userLevelChanged()` (`u_level`, a user approved by an admin) for the
user administration slice.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| POST `/api/v1/feedback` | `{ message, name, email, referer, browser }` (`browser` defaults to the User-Agent) | `{ sent: true }` |

Errors: 404 `not_found` (feedback switched off), 403 `no_permission` (blocked user or IP), 400
`validation_failed` (`message: required`), 400 `captcha_required`, 503 `email_failed`.

## Bridge

The feedback page's email moves, unchanged, into a new core function `qa_send_feedback()` in
`app/emails.php` with the standard `qa_to_override` hook; the bridge sends it to Node. The private
message override now returns Node's `emailed` flag instead of sending the email in PHP.
Notifications for the other changes need no bridge code: Node sends them when it makes the change.

## Parity tests

`node-api/tests/parity/notifications.test.js` (12 cases) does each of the steps above on the PHP
site, the shared UI and the API, and compares every email Mailpit catches during each step:
recipients, sender, reply-to, subject and text, with each backend's users, tokens and post IDs
masked. The other suites keep checking that the same changes write the same data.

## Known differences

- Q2A 1.8.8 reports the answer a new question follows as `parent`, but the notify module reads
  `followanswer`, so the answer's author is never emailed. Node keeps that behaviour.
- Node sends nothing when `smtp_active` is off (see the account notes).
- Custom notification plugins (other event modules) are not called by Node.
