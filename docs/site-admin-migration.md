# Site administration migration

The eleventh migrated slice: everything an admin changes about the site. The Node API checks and
writes; PHP renders the admin pages. Reference behaviour: `pages/admin/admin-default.php` (the
option forms and mailings), `admin-categories.php`, `admin-pages.php`, `admin-widgets.php`,
`admin-usertitles.php`, `admin-userfields.php`, `admin-points.php`, `admin-plugins.php`,
`admin-stats.php` and `admin-recalc.php`, with `app/recalc.php`, `db/recalc.php`, `app/mailing.php`,
`qa_reset_options()` and `qa_default_option()`. Every endpoint needs an admin (level 100), as
`qa_admin_check_privileges()` does.

## v1 contract

| Method and path | Body | Does |
| --- | --- | --- |
| PUT `/api/v1/admin/options` | `{ values: { name: value } }` | Save options with the forms' types, limits and tidying; `recalcHotness` says whether hotness weights changed |
| POST `/api/v1/admin/options/reset` | `{ names, site }` | Reset options to their defaults (`site` gives the host and installed editor/captcha) |
| PUT `/api/v1/admin/default-avatar` | the image (`image/*`) | Set the default avatar |
| POST `/api/v1/admin/categories`, PUT `/categories/:id` | `name`, `slug`, `content`, `position`, `parentid`, `setParent` | Add or edit a category; `recalc` says whether categories need recalculating |
| DELETE `/api/v1/admin/categories/:id`, POST `/categories/:id/reassign` | `{ reassignTo }` | Delete an empty category, or move its questions |
| POST `/api/v1/admin/pages`, PUT `/pages/:id`, DELETE `/pages/:id` | `external`, `name`, `position` ("F3"), `permit`, `url`, `newWindow`, `heading`, `slug`, `content` | Custom pages and links |
| POST `/api/v1/admin/widgets`, PUT `/widgets/:id`, DELETE `/widgets/:id` | `title` (the widget), `templates`, `position` ("SL2") | Widgets |
| POST `/api/v1/admin/user-titles` | `oldPoints`, `points`, `title`, `remove` | Add, change or remove a user title |
| POST `/api/v1/admin/user-fields`, PUT `/user-fields/:id`, DELETE `/user-fields/:id` | `name`, `type`, `onRegister`, `position`, `permit` | User profile fields |
| POST `/api/v1/admin/recalc` | `{ state, seconds }` | Advance a recalculation tool (start with `dorecountposts`, `doreindexcontent`, `dorecalcpoints`, `dorefillevents`, `dorecalccategories` or `dodeletehidden`); returns the next `state`, empty when done |
| POST `/api/v1/admin/mailing/test`, `/start`, `/stop`, `/step` | — | Send yourself the mailing, start, stop, or send the next batch |
| PUT `/api/v1/admin/plugins` | `{ directories }` | The enabled plugins |

Saves that keep going past a failed field (editing pages, user titles and fields, as the pages do)
return the failures in `errors`; new items with errors are refused with 400 `validation_failed`.

## What Node reproduces

- Options: number, checkbox and number-blank conversion (PHP's `(int)`), the forms' minimums and
  maximums, the trailing slash on `site_url`, tidied IP and word block lists, hotness weight changes,
  and `qa_default_option()` for resets, including the defaults that depend on other options, the
  host, language strings, and the installed editor and captcha (which the PHP page passes on).
- Categories: name and slug rules (required, length, `+`/`/`, reserved slugs, siblings, top-level
  pages), the slug fallbacks for new categories, positions (`qa_db_ordered_move()`), moving under
  another parent within four levels, back-paths, deleting only empty categories, and moving
  questions out.
- Pages and links: the same name and slug rules, new-page slug fallbacks, URLs, permissions,
  menus and positions; edits keep the old value of a field that fails.
- Widgets, user titles (the `points_to_titles` option, kept in points order) and user fields (tags
  made unique from the label, flags, permissions and positions).
- The recalculation tools, step by step with PHP's batch sizes and state strings: recounting posts,
  votes, flags, answers and hotness; recalculating points and the cached user counts; recalculating
  categories (answer and comment categories, category paths, question counts, back-paths);
  reindexing the search index and recounting words; refilling every question's update streams at
  their original times; and deleting hidden posts that have no answers or comments.
- Mailings: starting, stopping, sending paced batches at `mailing_per_minute` to users who accept
  mailings (not blocked, approved when users are moderated), unsubscribe codes and links, and the
  test message to the admin.
- Plugins: the `enabled_plugins` option.

## Bridge

The option forms' save loop, the default avatar, and the writes of the categories, pages, widgets,
user titles and user fields pages move, unchanged, into new core functions in `app/admin.php` with
the standard `qa_to_override` hook (`qa_admin_set_options()`, `qa_admin_set_default_avatar()`,
`qa_admin_save_category()`, `qa_admin_delete_category()`, `qa_admin_reassign_category()`,
`qa_admin_save_page()`, `qa_admin_delete_page()`, `qa_admin_save_widget()`,
`qa_admin_delete_widget()`, `qa_admin_save_user_title()`, `qa_admin_save_userfield()`,
`qa_admin_delete_userfield()`, `qa_admin_set_enabled_plugins()`). The recalculation pages call a new
`qa_recalc_perform_steps()` (the step function takes its state by reference, which overrides cannot
return), and the mailing functions gain the hook. The bridge overrides them all and sends
`X-Q2A-Admin-Backend: node-api-v1`.

## Parity tests

`node-api/tests/parity/site-admin.test.js` (28 cases) uses the real admin pages on the PHP site and
the shared UI, and the API: option forms (with limits, tidying and resets), categories, custom pages
and links, widgets, user titles, user fields, points, plugins and the test mailing. Options are
compared by the value Q2A reads (the stored value or its default).

`node-api/tests/parity/recalc.test.js` (6 cases) breaks values on its own posts and users and runs
each recalculation tool on all three backends. The tools work through the whole database, so this
suite takes minutes and runs only with `RECALC_PARITY=1`:

```bash
docker compose run --rm -e RECALC_PARITY=1 tests npx jest --runInBand tests/parity/recalc.test.js
```

## Known differences

- Node cannot see PHP's plugins: widget names and enabled plugin directories are taken as given
  (the pages only offer installed ones), and slugs claimed by plugin pages are not reserved.
- Moving blobs between the database and disk does nothing in Node (blobs stay in the database, as in
  this setup), and clearing or trimming the PHP file cache stays in PHP.
- The built-in search module does not index custom pages, so reindexing only counts them, as PHP does.
- Deleting hidden posts uses the same rules as the delete button, so a post the admin could not
  delete from its page is skipped.
