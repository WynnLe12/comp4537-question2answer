# Full backend migration roadmap

Goal: every piece of Q2A backend logic (validation, permissions, rate limits, database writes,
counters, points, events) runs in the Node API. PHP keeps rendering the pages; on the migrated site
(port 8081) the `node-auth-bridge` plugin sends each operation to Node. The PHP site on port 8080
stays unchanged as the reference, and every slice ships with parity tests that run the same
operations against both and compare the database.

## How the bridge reaches each operation

Q2A lets plugins replace a fixed list of functions (`qa_to_override`). Voting, flags and authentication
use functions already on that list. Most other write functions (post creation, editing,
favorites, messages, admin) are not on it. For those, a one-line `qa_to_override` hook is added to
the core function — the same mechanism Q2A uses everywhere else. Without a plugin overriding it,
the hook does nothing, so the PHP reference keeps its behaviour.

## Status

| # | Slice | PHP source | Status |
| --- | --- | --- | --- |
| 1 | Authentication: register, login, logout, session | `app/users.php`, `app/users-edit.php`, `pages/login.php`, `pages/register.php` | Done ([notes](auth-migration.md)) |
| 2 | Voting | `app/votes.php` (votes) | Done ([notes](votes-migration.md)) |
| 3 | Posting: ask, answer, comment, moderation queue, search index, counts, update streams | `app/post-create.php`, `app/posts.php`, `plugins/qa-search-basic.php`, `plugins/qa-event-updates.php`, `pages/ask.php`, `pages/question-post.php`, `ajax/answer.php`, `ajax/comment.php` | Done ([notes](posts-migration.md)) |
| 4 | Post changes: edit, retag, recategorize, close/reopen, hide/reshow/delete, select answer, convert answer↔comment | `app/post-update.php`, `pages/question-post.php`, `ajax/click-*.php` | Done ([notes](post-changes-migration.md)) |
| 5 | Flags | `app/votes.php` (flags) | Done ([notes](flags-migration.md)) |
| 6 | Favorites | `app/favorites.php`, `ajax/favorite.php` | Done ([notes](favorites-migration.md)) |
| 7 | Messages and wall posts | `app/messages.php`, `pages/message.php`, `pages/user-wall.php` | Done ([notes](messages-migration.md)) |
| 8 | Account and profile: edit profile, change password/email, avatars, password reset, email confirmation, unsubscribe | `pages/account.php`, `pages/forgot.php`, `pages/reset.php`, `pages/confirm.php`, `pages/unsubscribe.php`, `app/blobs.php` | Done ([notes](account-migration.md)) |
| 8b | Editor uploads: images and files added through the editor | `app/upload.php`, `ajax/upload.php`, `plugins/wysiwyg-editor/` | Not started |
| 9 | Email notifications, welcome emails, private message emails and feedback | `plugins/qa-event-notify.php`, `app/emails.php`, `pages/feedback.php` | Done ([notes](notifications-migration.md)); bulk mailings (`app/mailing.php`) are an admin tool and move with slice 11 |
| 10 | Moderation and user administration: approve queue, user levels, block/unblock, delete user | `pages/admin/admin-moderate.php`, `admin-approve.php`, `admin-flagged.php`, `admin-hidden.php`, `pages/user-profile.php` | Done ([notes](admin-migration.md)) |
| 11 | Site administration: options, categories, pages, widgets, plugins, points, user titles, user fields, recalculation | `pages/admin/*`, `app/admin.php`, `app/recalc.php` | Not started |
| 12 | Reads: question lists, search, tags, users, activity, feeds | `app/q-list.php`, `app/search.php`, `db/selects.php` | Not started — see below |

### Reads

Slices 1–11 move every write and every rule that decides one. PHP pages still read MySQL directly
to render. Moving reads means each page asks Node for its data instead. That changes every page
controller, so it comes last, after the writes it depends on are stable.
