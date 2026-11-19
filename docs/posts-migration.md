# Posting migration

The third migrated slice. Asking questions, answering and commenting are checked and written by
the Node API. PHP still renders the ask page and question pages. Reference behaviour:
`qa_question_create()`, `qa_answer_create()` and `qa_comment_create()` in
`qa-include/app/post-create.php`, the checks in `pages/ask.php`, `pages/question-post.php` and
`pages/question-submit.php`, the basic filter, search and event modules in `qa-include/plugins/`.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| POST `/api/v1/questions` | `title`, `content`, `format` (`''` or `'html'`), `tags` (string as typed, or array), `notify`, `email`, `name`, `categoryid`, `followAnswerId`, `extra` | 201, `{ id, type, queued }` |
| POST `/api/v1/questions/:id/answers` | `content`, `format`, `notify`, `email`, `name` | 201, `{ id, type, queued }` |
| POST `/api/v1/posts/:id/comments` | the same (`:id` is a question or an answer) | 201, `{ id, type, queued }` |

Requests need JSON and `X-Q2A-Request: 1`. A signed-in user is identified by the session
cookie. Anonymous posting is allowed where Q2A's permissions allow it (the default): the post is
tied to Q2A's `qa_id` visitor cookie, which Node creates and sets when the visitor has none.
`type` is `Q_QUEUED`, `A_QUEUED` or `C_QUEUED` when the post went to the moderation queue.

Errors, in the order the PHP pages check them:

| Status | `error.code` | Meaning |
| --- | --- | --- |
| 404 | `question_not_found`, `post_not_found` | No such question, or the parent cannot take comments |
| 403 | `question_not_viewable` | Hidden or queued question the user cannot see |
| 403 | `answer_not_allowed`, `comment_not_allowed` | The page would not show the answer/comment button (closed question, own question with self-answers off, second answer with multiple answers off, comments switched off) |
| 401 | `unauthenticated` | The permission needs a signed-in user |
| 403 | `ask_must_confirm`, `answer_must_be_approved`, … | Email confirmation or approval needed |
| 429 | `ask_limit`, `answer_limit`, `comment_limit` | Hourly per-user or per-IP limit |
| 403 | `no_permission` | Level, blocked user or blocked IP |
| 400 | `validation_failed` | `fields` holds `title`/`content`/`tags`/`email`/`categoryid` with `required`, `min_length`, `max_length`, `min_tags`, `max_tags`, `invalid` or `not_allowed` |
| 409 | `duplicate_content` | Same words as a recent question, or as another answer/comment on the same post |
| 400 | `captcha_required` | A captcha is configured and needed (Node cannot verify captchas) |

## What Node reproduces

- Checks: `permit_post_q/a/c` with category-specific levels, the page-level limit checks,
  `permit_view_q_page`, visibility of hidden and queued questions, closed questions,
  `allow_self_answer`, `allow_multi_answers`, `comment_on_qs`/`comment_on_as`, required
  categories, follow-on answers, the basic filter's length/tag/email rules (character counts,
  4-byte characters removed), duplicate detection by Q2A's word splitting, and the moderation
  queue rules (`moderate_users`, `moderate_unconfirmed`, `moderate_by_points`, `moderate_anon_post`).
- Writes, in PHP's order: the post row (including `notify`, anonymous `name`, `createip`,
  category path and `qa_q_extra` meta), question hotness, the search word index
  (`qa_words`, `qa_titlewords`, `qa_contentwords`, `qa_tagwords`, `qa_posttags` and word counts),
  answer counts, the cached totals (`cache_qcount`, `acount`, `ccount`, `unaqcount`,
  `unselqcount`, `unupaqcount`, `queuedcount`, `tagcount`), category question counts, author
  points, rate-limit counters, `written`/`writeip` for users or visitor cookies, and the update
  streams (`qa_sharedevents`, `qa_userevents`) for the question, the author, tags, categories,
  earlier commenters and the parent's author.
- `node-api/src/q2a/text.js` ports Q2A's word splitting and HTML-to-text conversion.
  `tests/fixtures/php-text-outputs.json` holds PHP's own output for multilingual samples, and the
  unit tests check Node against it.

## Bridge

`qa_question_create()`, `qa_answer_create()` and `qa_comment_create()` now start with Q2A's
standard `qa_to_override` hook, so a plugin can replace them; without a plugin they behave exactly
as before, so the PHP reference site is unchanged. The bridge overrides them to call Node, and
overrides `qa_cookie_get_create()` so Node, not PHP, creates visitor cookies (it relays Node's
`qa_id` cookie to the browser). Responses carry `X-Q2A-Post-Backend: node-api-v1`. The ajax answer and comment forms
(`ajax/answer.php`, `ajax/comment.php`) call the same create functions, so they go to Node too.

The PHP page still checks the form before calling the create function, so it can redisplay the
form with its own field errors. Node then runs every check again and does every write. The API
on its own is a complete backend for posting.

## Parity tests

`node-api/tests/parity/posts.test.js` runs every case three times: the PHP reference through its
real forms (including the editor's fields and form codes), the shared UI on port 8081, and the
Node API. After each step it compares acceptance, the page messages, and every value above.
Timestamps differ between backends, so hotness is checked against the formula, and totals that
depend on each database's history are compared as changes. Cases:
- questions with tags, HTML content, anonymous authors, follow-on questions and the moderation queue
- answers (first and later), anonymous answers, comments on answers and on questions
- short titles, short content, too many tags, invalid notification email, duplicates
- hidden questions, comments switched off, rate limits and blocked users

## Known differences

- HTML content is sanitized by Q2A's editor (htmLawed) in PHP before the bridge calls Node, and
  again whenever PHP displays it. Node stores `format: 'html'` content as received, so a direct
  API client is not normalized by htmLawed.
- PHP takes `LOCK TABLES qa_words` while adding new words. That would commit Node's transaction,
  so Node relies on `INSERT IGNORE` against the unique word index, which gives the same result.
- Email notifications from `qa_event_notify` are sent by Node since the [notifications slice](notifications-migration.md).
- Captchas: Node cannot verify one, so it returns `captcha_required` when a captcha module with
  keys is configured and Q2A would ask for one. None is configured by default.
- Q2A's optional question cache (`caching_enabled`, off by default) is not cleared by Node.
- Email addresses are checked with the `validator` package's ASCII rules, the closest match to
  PHP's `FILTER_VALIDATE_EMAIL`.
- Uploads also call `qa_cookie_get_create()`. With the bridge it returns the browser's cookie
  without creating one, until uploads are migrated.
