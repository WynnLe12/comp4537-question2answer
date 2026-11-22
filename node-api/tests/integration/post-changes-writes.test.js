// The complete write log of each post change (services/post-changes.js): every repository call, in order,
// with its arguments, for a grid of edits, status changes, conversions, deletions, closings and flags.
// The logs are Jest snapshots (__snapshots__/post-changes-writes.test.js.snap). The post-change parity
// suite compares these same writes (post rows, the word index, cached counts, points, update streams,
// emails) with what PHP's app/post-update.php writes, so the snapshots record behaviour that matches PHP;
// any change to a write shows up here as a diff to review. Update them (npx jest -u) only for a change
// the parity suite also accepts.
const nodemailer = require('nodemailer');
const { createPostChangeService } = require('../../src/services/post-changes');
const { fakeRepository, optionsWith } = require('./fake-repository');

const OPTIONS = {
  permit_view_q_page: '150', permit_post_q: '150', permit_post_a: '150', permit_post_c: '150', permit_edit_q: '70', permit_edit_a: '100', permit_edit_c: '70',
  permit_retag_cat: '70', permit_flag: '110', permit_hide_show: '70', permit_close_q: '70', permit_moderate: '100', permit_select_a: '100',
  permit_delete_hidden: '40', permit_edit_silent: '40', allow_close_questions: '1', allow_close_own_questions: '1', allow_self_answer: '1',
  allow_multi_answers: '1', comment_on_qs: '1', comment_on_as: '1', flagging_of_posts: '1', flagging_hide_after: '3', flagging_notify_first: '1',
  flagging_notify_every: '2', max_rate_user_flags: '10', max_rate_ip_flags: '10', max_rate_user_cs: '10', max_rate_ip_cs: '10', max_rate_user_qs: '10', max_rate_ip_qs: '10', max_rate_user_as: '10', max_rate_ip_as: '10', tags_or_categories: 'tc',
  min_len_q_title: '5', max_len_q_title: '120', min_len_q_content: '0', min_num_q_tags: '0', max_num_q_tags: '5', min_len_a_content: '3',
  min_len_c_content: '3', site_url: 'http://site.test/', neat_urls: '1', q_urls_title_length: '50', max_store_user_updates: '50',
  feedback_email: 'admin@site.test', moderate_notify_admin: '1', site_title: 'Site', from_email: 'f@site.test',
  smtp_active: '1', smtp_address: 'writes.test', smtp_port: '25',
};
const USERS = {
  5: { userid: '5', handle: 'asker', level: '0', flags: '1', points: '0' },
  6: { userid: '6', handle: 'mod', level: '80', flags: '1', points: '0' },
  7: { userid: '7', handle: 'answerer', level: '0', flags: '1', points: '0' },
};
const base = { hidden: 0, queued: 0, cookieid: null, lastuserid: null, closedbyid: null, selchildid: null, flagcount: '0', categoryid: null, categoryids: '', updated: null, netvotes: '0', format: '', name: null, notify: null, tags: '', created: null };
const Q = changes => ({ ...base, postid: '1', type: 'Q', basetype: 'Q', parentid: null, userid: '5', title: 'Question title here', content: 'question <b>text</b>', format: 'html', tags: 'alpha,beta', categoryid: '3', acount: '2', amaxvote: '2', ...changes });
const A = (id, changes) => ({ ...base, postid: String(id), type: 'A', basetype: 'A', parentid: '1', userid: '7', content: `answer number ${id}`, netvotes: '1', notify: '@', ...changes });
const C = (id, parentid, changes) => ({ ...base, postid: String(id), type: 'C', basetype: 'C', parentid: String(parentid), userid: '7', content: `comment number ${id}`, notify: '@', ...changes });
const NOTE = { ...base, postid: '30', type: 'NOTE', basetype: 'N', parentid: '1', userid: '6', content: 'closing note' };

// The calls as plain data: the options object becomes a marker; queued emails are run and recorded.
function logOf(fake) {
  return fake.calls.map(([name, ...args]) => [name, ...args.map(arg => (arg && typeof arg.get === 'function' ? '<options>' : arg instanceof Map ? Object.fromEntries(arg) : arg))]);
}
async function run({ posts, options = {}, userflag = 0, duplicates = [], answers = {} }, operation, request) {
  const byId = new Map(posts.map(p => [Number(p.postid), p]));
  let nextId = 90;
  const fake = fakeRepository({
    loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => USERS[id] ?? null,
    findPost: id => byId.get(Number(id)), findChildren: id => posts.filter(p => String(p.parentid) === String(id)), findDuplicates: duplicates,
    userFlag: userflag, findLimits: {}, filterQuestionIds: ids => ids.filter(id => byId.get(id)?.basetype === 'Q'), insertPost: () => nextId++,
    postUserVotes: [{ userid: '8', vote: 1 }, { userid: '9', vote: -1 }], getCategoryPath: [3], findHandle: id => (id ? `user${id}` : null),
    wordMapToIdsAdd: words => new Map(words.map((w, i) => [w, 100 + i])), wordMapToIds: words => new Map(words.map((w, i) => [w, 200 + i])),
    indexedWordIds: table => [table.length], userflagsClearAll: 2, setAmaxvote: 1, categoryPath: id => (Number(id) === 4 ? [{ categoryid: 2 }, { categoryid: 4 }] : [{ categoryid: 3 }]),
    findUserEmailHandle: id => ({ email: `u${id}@x.test`, handle: `user${id}` }), countAnswers: 1, maxAnswerVote: 0,
    ...answers,
  });
  const service = createPostChangeService(fake.repository, { identify: async token => (token in USERS ? { id: Number(token) } : null) });
  let outcome;
  try { outcome = await service[operation]({ ip: '1.2.3.4', cookieid: null, ...request }); } catch (error) { outcome = { error: error.code ?? error.message, status: error.status, fields: error.fields }; }
  // The emails queued for after the commit, as they would be sent.
  sent.length = 0;
  for (const task of fake.afterCommit) await task();
  return { outcome, writes: logOf(fake), emails: sent.map(m => ({ to: m.to.address, subject: m.subject, text: m.text })) };
}

const sent = [];
beforeAll(() => jest.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: async m => { sent.push(m); } })));
afterAll(() => jest.restoreAllMocks());

const page = (extra = {}) => ({ posts: [Q(), A(2), A(3, { userid: '5', netvotes: '2' }), C(4, 2), C(5, 1, { userid: '6' })], ...extra });

const SCENARIOS = {
  // --- status changes ---
  'hide own answer': [page(), 'setStatus', { token: '7', postid: 2, body: { action: 'hide' } }],
  'hide the best-voted answer (amaxvote recounted)': [page(), 'setStatus', { token: '5', postid: 3, body: { action: 'hide' } }],
  'hide the only answer (question back to unanswered)': [page({ posts: [Q({ acount: '1', amaxvote: '1' }), A(2)] }), 'setStatus', { token: '7', postid: 2, body: { action: 'hide' } }],
  'hide the only answer of a closed question': [page({ posts: [Q({ acount: '1', amaxvote: '1', closedbyid: '30' }), A(2), NOTE] }), 'setStatus', { token: '7', postid: 2, body: { action: 'hide' } }],
  'hide the selected answer': [page({ posts: [Q({ selchildid: '2' }), A(2), C(4, 2)] }), 'setStatus', { token: '7', postid: 2, body: { action: 'hide' } }],
  'hide a flagged answer': [page({ posts: [Q(), A(2, { flagcount: '2' })] }), 'setStatus', { token: '7', postid: 2, body: { action: 'hide' } }],
  'reshow an answer (mod)': [page({ posts: [Q({ amaxvote: '0', acount: '0' }), A(2, { type: 'A_HIDDEN', hidden: 1, netvotes: '3', flagcount: '1' }), C(4, 2)] }), 'setStatus', { token: '6', postid: 2, body: { action: 'reshow' } }],
  'reshow an answer back to the queue': [page({ posts: [Q(), A(2, { type: 'A_HIDDEN', hidden: 1, lastuserid: '7' })], options: { moderate_users: '1', moderate_unapproved: '1' } }), 'setStatus', { token: '7', postid: 2, body: { action: 'reshow' } }],
  'approve a new answer': [page({ posts: [Q({ acount: '0', amaxvote: '0' }), A(2, { type: 'A_QUEUED', queued: 1 })] }), 'setStatus', { token: '6', postid: 2, body: { action: 'approve' } }],
  'approve a requeued answer with moderate_update_time': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1, updated: '2026-01-01' })], options: { moderate_update_time: '1' } }), 'setStatus', { token: '6', postid: 2, body: { action: 'approve' } }],
  'approve a new answer with moderate_update_time': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1 })], options: { moderate_update_time: '1' } }), 'setStatus', { token: '6', postid: 2, body: { action: 'approve' } }],
  'reject a queued answer': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1 })] }), 'setStatus', { token: '6', postid: 2, body: { action: 'reject' } }],
  'hide own question with answers, comments and a note': [page({ posts: [Q({ closedbyid: '30', flagcount: '1' }), A(2), C(4, 2), C(5, 1), NOTE] }), 'setStatus', { token: '5', postid: 1, body: { action: 'hide' } }],
  'reshow a question (mod)': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1, closedbyid: '30' }), A(2), A(6, { type: 'A_HIDDEN', hidden: 1 }), C(4, 2), C(7, 6), C(5, 1, { type: 'C_HIDDEN', hidden: 1 }), NOTE] }), 'setStatus', { token: '6', postid: 1, body: { action: 'reshow' } }],
  'approve a new follow-on question': [page({ posts: [Q({ type: 'Q_QUEUED', queued: 1, parentid: '20' }), { ...A(20), parentid: '40' }] }), 'setStatus', { token: '6', postid: 1, body: { action: 'approve' } }],
  'approve a new question with moderate_update_time': [page({ posts: [Q({ type: 'Q_QUEUED', queued: 1 })], options: { moderate_update_time: '1' } }), 'setStatus', { token: '6', postid: 1, body: { action: 'approve' } }],
  'approve a requeued question with moderate_update_time': [page({ posts: [Q({ type: 'Q_QUEUED', queued: 1, updated: '2026-01-01' })], options: { moderate_update_time: '1' } }), 'setStatus', { token: '6', postid: 1, body: { action: 'approve' } }],
  'reject a queued question': [page({ posts: [Q({ type: 'Q_QUEUED', queued: 1 })] }), 'setStatus', { token: '6', postid: 1, body: { action: 'reject' } }],
  'hide a comment on an answer': [page(), 'setStatus', { token: '7', postid: 4, body: { action: 'hide' } }],
  'hide a flagged comment on the question (mod)': [page({ posts: [Q(), C(5, 1, { userid: '7', flagcount: '1' })] }), 'setStatus', { token: '6', postid: 5, body: { action: 'hide' } }],
  'reshow a comment': [page({ posts: [Q(), A(2), C(4, 2, { type: 'C_HIDDEN', hidden: 1 })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'reshow' } }],
  'approve a new comment in a thread': [page({ posts: [Q(), A(2), C(8, 2, { userid: '5' }), C(9, 2, { userid: '7' }), C(4, 2, { type: 'C_QUEUED', queued: 1, userid: '9' })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'approve' } }],
  'approve a new comment on the question': [page({ posts: [Q(), C(4, 1, { type: 'C_QUEUED', queued: 1 })], options: { moderate_update_time: '1' } }), 'setStatus', { token: '6', postid: 4, body: { action: 'approve' } }],
  'approve a requeued comment': [page({ posts: [Q(), C(4, 1, { type: 'C_QUEUED', queued: 1, updated: '2026-01-01' })], options: { moderate_update_time: '1' } }), 'setStatus', { token: '6', postid: 4, body: { action: 'approve' } }],
  'reject a queued comment': [page({ posts: [Q(), A(2), C(4, 2, { type: 'C_QUEUED', queued: 1 })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'reject' } }],
  'flags hide a comment': [page({ posts: [Q(), C(4, 1, { flagcount: '2' })] }), 'flagPost', { token: '5', postid: 4 }],
  'flags hide a question': [page({ posts: [Q({ userid: '7', flagcount: '2' }), A(2, { userid: '5' })] }), 'flagPost', { token: '5', postid: 1 }],
  'clear flags (mod)': [page({ posts: [Q(), A(2, { flagcount: '2' })] }), 'clearFlags', { token: '6', postid: 2 }],

  // --- edits ---
  'edit question title, content and tags': [page(), 'editPost', { token: '5', postid: 1, body: { title: 'A clearer question title', content: 'new content', format: '', tags: ['gamma', 'beta'] } }],
  'edit only the question tags': [page(), 'editPost', { token: '5', postid: 1, body: { tags: 'delta' } }],
  'edit question with notify and extra': [page({ options: { extra_field_active: '1' } }), 'editPost', { token: '5', postid: 1, body: { content: 'more', notify: true, email: 'a@x.test', extra: 'note' } }],
  'silent edit by a moderator': [page(), 'editPost', { token: '6', postid: 1, body: { content: 'fixed typo', silent: true } }],
  'moderator edit that is not silent': [page(), 'editPost', { token: '6', postid: 1, body: { content: 'fixed typo' } }],
  'edit question category': [page(), 'editPost', { token: '5', postid: 1, body: { categoryid: 4 } }],
  'edit question to no category': [page(), 'editPost', { token: '5', postid: 1, body: { categoryid: null } }],
  'edit hidden-free question that goes back to the queue': [page({ options: { moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' } }), 'editPost', { token: '5', postid: 1, body: { content: 'needs review' } }],
  'edit a queued question': [page({ posts: [Q({ type: 'Q_QUEUED', queued: 1 })] }), 'editPost', { token: '5', postid: 1, body: { title: 'Queued title edited' } }],
  'edit an answer': [page(), 'editPost', { token: '7', postid: 2, body: { content: 'improved answer', notify: false } }],
  'edit an answer of a closed question': [page({ posts: [Q({ closedbyid: '30' }), A(2), NOTE] }), 'editPost', { token: '7', postid: 2, body: { content: 'improved answer' } }],
  'edit an answer that goes back to the queue': [page({ options: { moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' } }), 'editPost', { token: '7', postid: 2, body: { content: 'improved answer' } }],
  'edit a queued answer': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1 })] }), 'editPost', { token: '7', postid: 2, body: { content: 'improved answer' } }],
  'convert an answer to a comment on the question': [page(), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1 } }],
  'convert the selected answer to a comment on another answer': [page({ posts: [Q({ selchildid: '2' }), A(2, { flagcount: '1' }), A(3, { userid: '5' }), C(4, 2), C(6, 2, { type: 'C_HIDDEN', hidden: 1 })] }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 3, content: 'now a comment' } }],
  'convert the only answer to a comment': [page({ posts: [Q({ acount: '1', amaxvote: '1' }), A(2)] }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1 } }],
  'convert a queued answer to a comment': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1 })] }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1 } }],
  'convert an answer to a comment that goes to the queue': [page({ options: { moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' } }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1, content: 'changed while converting' } }],
  'edit a comment': [page(), 'editPost', { token: '7', postid: 4, body: { content: 'better comment' } }],
  'edit a comment silently (mod)': [page(), 'editPost', { token: '6', postid: 5, body: { content: 'better comment', silent: true } }],
  'edit a comment that goes back to the queue': [page({ options: { moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' } }), 'editPost', { token: '7', postid: 4, body: { content: 'better comment' } }],
  'edit a queued comment': [page({ posts: [Q(), A(2), C(4, 2, { type: 'C_QUEUED', queued: 1 })] }), 'editPost', { token: '7', postid: 4, body: { content: 'better comment' } }],
  'edit a comment with no change': [page(), 'editPost', { token: '7', postid: 4, body: { content: 'comment number 4' } }],

  // --- deleting, closing, claiming, selecting ---
  'delete a hidden comment': [page({ posts: [Q(), A(2), C(4, 2, { type: 'C_HIDDEN', hidden: 1 })] }), 'deletePost', { token: '6', postid: 4 }],
  'delete a hidden answer': [page({ posts: [Q(), A(2, { type: 'A_HIDDEN', hidden: 1 })] }), 'deletePost', { token: '6', postid: 2 }],
  'delete a hidden question': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1 })] }), 'deletePost', { token: '6', postid: 1 }],
  'close with a note': [page(), 'closeQuestion', { token: '5', questionid: 1, body: { details: 'Answered elsewhere' } }],
  'close as a duplicate': [page({ posts: [Q(), Q({ postid: '8' })] }), 'closeQuestion', { token: '5', questionid: 1, body: { details: 'http://site.test/8/original' } }],
  'reopen a question closed with a note': [page({ posts: [Q({ closedbyid: '30', lastuserid: '6' }), NOTE] }), 'reopenQuestion', { token: '6', questionid: 1 }],
  'claim an anonymous question': [page({ posts: [Q({ userid: null, cookieid: '123' })] }), 'claimPost', { token: '7', cookieid: '123', postid: 1 }],
  'claim an anonymous comment': [page({ posts: [Q(), C(4, 1, { userid: null, cookieid: '123' })] }), 'claimPost', { token: '7', cookieid: '123', postid: 4 }],
  'select an answer with close on select': [page({ options: { do_close_on_select: '1' } }), 'selectAnswer', { token: '5', questionid: 1, body: { answerId: 2 } }],

  // --- more edits, and the edits that are refused ---
  'edit question tags given as a list, comma separated': [page({ options: { tag_separator_comma: '1' } }), 'editPost', { token: '5', postid: 1, body: { tags: ['one two', 'three'] } }],
  'edit an anonymous question by its visitor, with a name': [page({ posts: [Q({ userid: null, cookieid: '123' })], options: { allow_anonymous_naming: '1' } }), 'editPost', { token: 'none', cookieid: '123', postid: 1, body: { name: ' Guest ', content: 'by a visitor' } }],
  'a moderator\'s edit keeps the author\'s notify and name': [page(), 'editPost', { token: '6', postid: 1, body: { notify: true, email: 'mod@x.test', name: 'Mod', content: 'by the mod' } }],
  'edit with the extra field switched off': [page(), 'editPost', { token: '5', postid: 1, body: { extra: 'ignored', title: 'Title changed again' } }],
  'retag only, by a user who may retag but not edit': [page({ options: { permit_edit_q: '40', permit_retag_cat: '120' } }), 'editPost', { token: '7', postid: 1, body: { tags: 'retagged', title: 'Not allowed to change' } }],
  'refused: tags that are not text': [page(), 'editPost', { token: '5', postid: 1, body: { tags: 5 } }, 'invalid_input'],
  'refused: a category ID as text': [page(), 'editPost', { token: '5', postid: 1, body: { categoryid: '4' } }, 'invalid_input'],
  'refused: an unknown category': [page({ answers: { categoryPath: [] } }), 'editPost', { token: '5', postid: 1, body: { categoryid: 99 } }, 'invalid_input'],
  'refused: a category the user may not post in': [page({ options: { permit_post_q: '100' } }), 'editPost', { token: '5', postid: 1, body: { categoryid: 4 } }, 'validation_failed'],
  'the same category is no change even when posting there is not allowed': [page({ options: { permit_post_q: '100' } }), 'editPost', { token: '5', postid: 1, body: { categoryid: 3, content: 'same category' } }],
  'refused: notify that is not a boolean': [page(), 'editPost', { token: '7', postid: 2, body: { notify: 1 } }, 'invalid_input'],
  'refused: converting onto a post ID as text': [page(), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: '1' } }, 'invalid_input'],
  'refused: a comment that is too short': [page(), 'editPost', { token: '7', postid: 4, body: { content: 'no' } }, 'validation_failed'],
  'refused: editing someone else\'s comment': [page(), 'editPost', { token: '5', postid: 4, body: { content: 'not mine' } }, 'edit_not_allowed'],
  'converting onto a question where comments are off keeps it an answer': [page({ options: { comment_on_qs: '' } }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1, content: 'still an answer' } }],

  // --- more status changes ---
  'reshow a comment back to the queue': [page({ posts: [Q(), A(2), C(4, 2, { type: 'C_HIDDEN', hidden: 1, lastuserid: '7' })], options: { moderate_users: '1', moderate_unapproved: '1' } }), 'setStatus', { token: '7', postid: 4, body: { action: 'reshow' } }],
  'reshow a question back to the queue': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1, lastuserid: '5' })], options: { moderate_users: '1', moderate_unapproved: '1' } }), 'setStatus', { token: '5', postid: 1, body: { action: 'reshow' } }],
  'approve an anonymous comment where the answer\'s author already commented': [page({ posts: [Q(), A(2), C(8, 2, { userid: '7' }), C(4, 2, { type: 'C_QUEUED', queued: 1, userid: null, cookieid: '55' })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'approve' } }],
  'approve a comment on a hidden question\'s answer (not indexed)': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1 }), A(2), C(4, 2, { type: 'C_QUEUED', queued: 1 })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'approve' } }],
  'hide an anonymous comment (no event for an author)': [page({ posts: [Q(), C(4, 1, { userid: null, cookieid: '55' })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'hide' } }],
  'clear flags from the admin page on a post with none left': [page({ posts: [Q(), A(2, { flagcount: '0' })] }), 'clearFlags', { token: '6', postid: 2 }],
  'refused: clearing flags without the permission': [page({ posts: [Q(), A(2, { flagcount: '2' })] }), 'clearFlags', { token: '7', postid: 2 }, 'clearflags_not_allowed'],

  // --- closing links ---
  'close with a link wrapped in odd characters': [page({ posts: [Q(), Q({ postid: '8' })] }), 'closeQuestion', { token: '5', questionid: 1, body: { details: ' «http://site.test/index.php?qa=8&qa_1=original» ' } }],
  'a link naming the same question twice counts once': [page({ posts: [Q(), Q({ postid: '8' })] }), 'closeQuestion', { token: '5', questionid: 1, body: { details: 'https://site.test/8/x?show=8' } }],
  'text that only looks like a link is a note': [page({ posts: [Q(), Q({ postid: '8' })] }), 'closeQuestion', { token: '5', questionid: 1, body: { details: 'see question 8 in site.test/8' } }],
  'refused: a link that names an answer, not a question': [page({ posts: [Q(), Q({ postid: '8' }), A(9, { parentid: '8' })] }), 'closeQuestion', { token: '5', questionid: 1, body: { details: 'http://site.test/9' } }, 'validation_failed'],
  'refused: closing text that is not text': [page(), 'closeQuestion', { token: '5', questionid: 1, body: { details: 5 } }, 'invalid_input'],

  // --- narrow states ---
  'hide an answer when another answer is selected': [page({ posts: [Q({ selchildid: '3' }), A(2), A(3, { userid: '5' })] }), 'setStatus', { token: '7', postid: 2, body: { action: 'hide' } }],
  'hide an answer of a hidden question (comments not reindexed)': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1 }), A(2), C(4, 2)] }), 'setStatus', { token: '6', postid: 2, body: { action: 'hide' } }],
  'reshow an answer whose score equals the best score': [page({ posts: [Q({ amaxvote: '2', acount: '1' }), A(2, { type: 'A_HIDDEN', hidden: 1, netvotes: '2' }), C(4, 2, { type: 'C_HIDDEN', hidden: 1 }), C(6, 2)] }), 'setStatus', { token: '6', postid: 2, body: { action: 'reshow' } }],
  'approve an answer on a closed question with no upvoted answers': [page({ posts: [Q({ amaxvote: '0', acount: '0', closedbyid: '30' }), A(2, { type: 'A_QUEUED', queued: 1, netvotes: '1' }), NOTE] }), 'setStatus', { token: '6', postid: 2, body: { action: 'approve' } }],
  'approve an answer without moderate_update_time': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1, updated: '2026-01-01' })] }), 'setStatus', { token: '6', postid: 2, body: { action: 'approve' } }],
  'hide an anonymous answer (no event for an author)': [page({ posts: [Q(), A(2, { userid: null, cookieid: '55' })] }), 'setStatus', { token: '6', postid: 2, body: { action: 'hide' } }],
  'reshow an answer to the queue, reported by the user': [page({ posts: [Q(), A(2, { type: 'A_HIDDEN', hidden: 1, lastuserid: '7', name: 'Ann' })], options: { moderate_users: '1', moderate_unapproved: '1' } }), 'setStatus', { token: '7', postid: 2, body: { action: 'reshow' } }],
  'approve a comment without moderate_update_time': [page({ posts: [Q(), C(4, 1, { type: 'C_QUEUED', queued: 1, updated: '2026-01-01' })] }), 'setStatus', { token: '6', postid: 4, body: { action: 'approve' } }],
  'approve a question without moderate_update_time': [page({ posts: [Q({ type: 'Q_QUEUED', queued: 1, updated: '2026-01-01' })] }), 'setStatus', { token: '6', postid: 1, body: { action: 'approve' } }],
  'convert a selected answer to a comment': [page({ posts: [Q({ selchildid: '2' }), A(2), A(3, { userid: '5' })] }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 3 } }],
  'convert an answer that another answer\'s selection does not touch': [page({ posts: [Q({ selchildid: '3' }), A(2), A(3, { userid: '5' })] }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1 } }],
  'convert a hidden question\'s answer (not indexed)': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1, lastuserid: '5' }), A(2)] }), 'editPost', { token: '6', postid: 2, body: { convertToCommentOn: 1 } }],
  'convert an answer silently (mod), changing only its format': [page({ posts: [Q(), A(2, { userid: '6', content: 'answer number 2', format: '' })] }), 'editPost', { token: '6', postid: 2, body: { convertToCommentOn: 1, content: 'answer number 2', format: 'html', silent: true } }],
  'convert a queued answer that stays queued': [page({ posts: [Q(), A(2, { type: 'A_QUEUED', queued: 1 })], options: { moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' } }), 'editPost', { token: '7', postid: 2, body: { convertToCommentOn: 1, content: 'queued and converted' } }],
  'edit an answer changing only its format': [page(), 'editPost', { token: '7', postid: 2, body: { content: 'answer number 2', format: 'html' } }],
  'edit an answer silently (mod)': [page({ posts: [Q(), A(2, { userid: '6' })] }), 'editPost', { token: '6', postid: 2, body: { content: 'quiet fix', silent: true } }],
  'edit the selected answer of a hidden question': [page({ posts: [Q({ selchildid: '2', type: 'Q_HIDDEN', hidden: 1, lastuserid: '5' }), A(2)] }), 'editPost', { token: '6', postid: 2, body: { content: 'edited while hidden' } }],
  'edit a question\'s title only': [page(), 'editPost', { token: '5', postid: 1, body: { title: 'Only the title changed' } }],
  'edit a question with no change': [page(), 'editPost', { token: '5', postid: 1, body: { title: 'Question title here' } }],
  'edit a question in a site without categories': [page({ options: { tags_or_categories: 't' } }), 'editPost', { token: '5', postid: 1, body: { categoryid: 4, content: 'categories off' } }],
  'clear flags on the question page (mod)': [page({ posts: [Q(), A(2, { flagcount: '1' })], userflag: 1 }), 'clearFlags', { token: '6', postid: 2 }],
  'flag a question (notifies the admin on the first flag)': [page({ posts: [Q({ userid: '7' })] }), 'flagPost', { token: '5', postid: 1 }],
  'flag an anonymous comment': [page({ posts: [Q(), C(4, 1, { userid: null, cookieid: '55', flagcount: '1' })] }), 'flagPost', { token: '5', postid: 4 }],
  'delete a hidden answer with no votes': [page({ posts: [Q(), A(2, { type: 'A_HIDDEN', hidden: 1 })], answers: { postUserVotes: [] } }), 'deletePost', { token: '6', postid: 2 }],
  'delete a hidden question with no votes': [page({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1 })], answers: { postUserVotes: [] } }), 'deletePost', { token: '6', postid: 1 }],
};

describe.each(Object.entries(SCENARIOS))('%s', (name, [setup, operation, request, refusal]) => {
  test('writes', async () => {
    const result = await run(setup, operation, request);
    expect(result.outcome?.error).toBe(refusal);
    expect(result).toMatchSnapshot();
  });
});
