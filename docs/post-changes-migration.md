# Post changes migration

The fourth migrated slice: everything that changes an existing question, answer or comment.
The Node API checks and writes; PHP renders the question page, its edit and close forms and its
buttons. Reference behaviour: `app/post-update.php`, the edit/close handlers in
`pages/question-post.php`, the button handlers in `pages/question-submit.php`
(`qa_page_q_single_click_q/a/c`) and the button rules of `qa_page_q_post_rules()`.

## v1 contract

| Method and path | Body | Does |
| --- | --- | --- |
| PATCH `/api/v1/posts/:id` | any of `title`, `content`, `format`, `tags`, `categoryid`, `notify`, `email`, `name`, `extra`, `silent`, `convertToCommentOn` | Edit, retag or move a question; edit an answer or comment; turn an answer into a comment |
| PUT `/api/v1/questions/:id/selected-answer` | `{ answerId }` (`null` to unselect) | Select the best answer |
| POST `/api/v1/questions/:id/close` | `{ details }` | Close: a link to another question closes it as a duplicate, other text becomes the closing note |
| DELETE `/api/v1/questions/:id/close` | — | Reopen |
| POST `/api/v1/posts/:id/status` | `{ action }`: `hide`, `reshow`, `approve`, `reject` | Hide, show again, or moderate |
| DELETE `/api/v1/posts/:id` | — | Delete a hidden post |
| POST `/api/v1/posts/:id/claim` | — | Claim a post made anonymously from the same browser |

Requests need JSON and `X-Q2A-Request: 1`. Fields left out of an edit keep their values; fields
the user may not change (for example the title for someone who may only retag) are ignored, as
the page simply does not show them. A reshown post goes back to the moderation queue when the
author's new posts would be moderated; `type` in the response says which.

Errors: 404 `post_not_found`/`question_not_found`/`answer_not_found`; 403 when the page would
not offer the action (`edit_not_allowed`, `select_not_allowed`, `close_not_allowed`,
`reopen_not_allowed`, `hide_not_allowed`, `reshow_not_allowed`, `approve_not_allowed`,
`reject_not_allowed`, `delete_not_allowed`, `claim_not_allowed`); 401 `unauthenticated` and 403
`edit_must_confirm`/`no_permission` from the edit permission switch; 400 `validation_failed`
with the same field codes as posting (and `details: required | duplicate_not_found` for
closing); 429 `comment_limit`, `ask_limit`, `answer_limit` for conversions and claims.

## What Node reproduces

- The button rules: author vs. permission checks (`permit_edit_q/a/c`, `permit_retag_cat`,
  `permit_edit_silent`, `permit_select_a`, `permit_close_q` with `allow_close_own_questions`,
  `permit_hide_show`, `permit_moderate`, `permit_delete_hidden`), closed and hidden posts,
  posts hidden or closed by someone else, flags, child posts blocking deletion, and the
  claim rules for self-answers and multiple answers.
- Edits: changed-field detection, the editor record (`updated`, `updatetype`, `lastuserid`,
  `lastip`), silent edits, notification settings, re-moderation (`moderate_edited_again`),
  reindexing, tag counts, category moves (including the category path of every answer and
  comment and the category question counts), and answer-to-comment conversion with its
  re-parenting, counts, points and comment rate limit.
- Selection, closing with notes or as a duplicate, reopening, hiding, showing, approving
  (including the delayed post events and new creation time), rejecting, deleting (with the
  voters' points) and claiming, each with the cached totals, `amaxvote`, hotness, points,
  flag counts, word index and update streams that PHP writes.

## Bridge

`app/post-update.php` gains the standard `qa_to_override` hook on 18 functions. The bridge
overrides them to call Node and sends `X-Q2A-Post-Backend: node-api-v1`. As with posting, the
PHP page validates the forms for redisplay and Node checks everything again.

A call with no user and no visitor cookie is a system action, so the bridge runs PHP's own
function for it. Q2A itself only makes one when flags hide a post, and since the
[flags slice](flags-migration.md) Node does that hiding itself; the fallback remains only for
plugins that call these functions directly.

## Parity tests

`node-api/tests/parity/post-changes.test.js` (29 cases) drives the real edit forms, close form
and buttons on the PHP site and the shared UI, and the API, then compares every value above.
`tests/parity/post-helpers.js` holds the drivers and snapshot shared with the posting suite.

## Known differences

- Edit requests are partial: omitted fields keep their values. The form always sends every field
  it shows, so the bridge behaves exactly like PHP.
- Selecting an answer follows the question page's rule (the ajax button is slightly stricter when
  `do_close_on_select` is on and an answer is already selected).
- An unknown category ID in an edit is rejected with 400; PHP would hit a database error.
- Q2A keeps 5 update events per question and trims them by timestamp, so which events survive a
  burst of changes within one second can differ between any two runs, in PHP too.
