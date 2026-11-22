// Creating questions, answers and comments (services/posts.js), driven directly with the repository
// replaced: the checks in PHP's order, the post written, and every count, index entry, event and email it
// sets off. The parity suites hold the same service to the PHP site; these pin each step.
const { createPostService } = require('../../src/services/posts');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const OPTIONS = {
  tags_or_categories: 'tc', tag_separator_comma: '', allow_no_category: '1', min_len_q_title: '5', max_len_q_title: '120', min_len_q_content: '0',
  min_num_q_tags: '0', max_num_q_tags: '5', min_len_a_content: '3', min_len_c_content: '3', permit_post_q: '150', permit_post_a: '150', permit_post_c: '150',
  permit_view_q_page: '150', permit_hide_show: '70', permit_moderate: '100', permit_moderate_points: '0', max_rate_user_qs: '10', max_rate_ip_qs: '10',
  max_rate_user_as: '10', max_rate_ip_as: '10', max_rate_user_cs: '10', max_rate_ip_cs: '10', allow_self_answer: '1', allow_multi_answers: '1',
  comment_on_qs: '1', comment_on_as: '1', allow_anonymous_naming: '1', site_url: 'http://site.test/', neat_urls: '1', q_urls_title_length: '50',
  max_store_user_updates: '50',
};
const ME = { userid: '5', handle: 'me', level: '0', flags: '1', points: '100' };
const question = changes => ({ postid: '1', type: 'Q', basetype: 'Q', hidden: 0, queued: 0, userid: '9', cookieid: null, parentid: null, categoryid: '3', closedbyid: null, selchildid: null, acount: '0', title: 'Q', content: 'qc', format: '', notify: null, categoryids: '', ...changes });

function setup({ options = {}, user = ME, posts = {}, children = {}, answers: extra = {} } = {}) {
  const fake = fakeRepository({
    loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 5 ? user : null), findLimits: {},
    categoryPath: id => (id === 3 ? [{ categoryid: 3 }] : []), countCategories: 1, recentQuestions: [],
    findPost: id => posts[id], findChildren: id => children[id] ?? [], insertPost: 100,
    wordMapToIdsAdd: words => new Map(words.map((w, i) => [w, i + 1])), wordMapToIds: words => new Map(words.map((w, i) => [w, 50 + i])),
    cookieExists: id => id === '123', createCookie: '888', ...extra,
  });
  const service = createPostService(fake.repository, { identify: async token => (token === 'ok' ? { id: 5 } : null) });
  const req = (body, more = {}, token = 'ok') => ({ token, ip: '1.2.3.4', cookieid: more.cookieid ?? null, body, ...more });
  return { ...fake, service, req };
}

describe('asking a question', () => {
  const body = { title: '  A good question?  ', content: 'Some <b>content</b>', format: 'html', tags: ['Node', 'php'], categoryid: 3, notify: true, email: 'me@x.test' };
  test('the post, its category path, hotness, index, counts, points, limits, events and email', async () => {
    const s = setup();
    expect(await s.service.createQuestion(s.req(body))).toEqual({ id: 100, type: 'Q', queued: false, cookieid: undefined });
    expect(s.named('insertPost')[0][1]).toEqual({
      type: 'Q', parentid: null, userid: 5, cookieid: null, ip: '1.2.3.4', title: 'A good question?', content: 'Some <b>content</b>', format: 'html',
      tagstring: 'node,php', notify: 'me@x.test', categoryid: 3, name: null,
    });
    expect(s.names().filter(n => /^update|Update$|^calc|^add|^event|^increment|userWritten/.test(n))).toEqual([
      'calcCategoryPath', 'updateHotness', 'addTitleWords', 'addContentWords', 'addTagWords', 'addPostTags',
      'updateWordCounts', 'updateWordCounts', 'updateWordCounts', 'updateWordCounts',
      'categoryPathQcountUpdate', 'qcountUpdate', 'unaqcountUpdate', 'unselqcountUpdate', 'unupaqcountUpdate', 'tagcountUpdate', 'updatePoints',
      'incrementLimits', 'userWritten', 'eventCreateForEntity', 'eventCreateForEntity', 'eventCreateForEntity', 'eventCreateForEntity', 'eventCreateForEntity',
    ]);
    expect(s.named('updatePoints')[0].slice(0, 3)).toEqual(['updatePoints', 5, ['qposts']]);
    expect(s.named('eventCreateForEntity').map(c => c.slice(1, 3))).toEqual([['Q', 100], ['U', 5], ['T', 50], ['T', 51], ['C', 3]]);
    expect(s.named('incrementLimits')[0]).toEqual(['incrementLimits', 5, '1.2.3.4', 'Q', 2000]);
  });
  test('tags may come as text, split by spaces or commas', async () => {
    const s = setup();
    await s.service.createQuestion(s.req({ title: 'Title here', content: '', tags: 'a b' }));
    expect(s.named('insertPost')[0][1].tagstring).toBe('a,b');
    const comma = setup({ options: { tag_separator_comma: '1' } });
    await comma.service.createQuestion(comma.req({ title: 'Title here', content: '', tags: ['x y', 'z'] }));
    expect(comma.named('insertPost')[0][1].tagstring).toBe('x y,z');
    await rejectsWith(s.service.createQuestion(s.req({ title: 'Title here', tags: 5 })), 400, 'invalid_input', { tags: 'invalid' });
  });
  test('without tags in use there are no tags; an unknown category is no category', async () => {
    const s = setup({ options: { tags_or_categories: 'c' } });
    await s.service.createQuestion(s.req({ title: 'Title here', tags: ['a'], categoryid: 77 }));
    expect(s.named('insertPost')[0][1]).toMatchObject({ tagstring: '', categoryid: null });
  });
  test('a category is required when categories are in use and "no category" is off', async () => {
    const s = setup({ options: { allow_no_category: '' } });
    await rejectsWith(s.service.createQuestion(s.req({ title: 'Title here' })), 400, 'validation_failed', { categoryid: 'required' });
    const none = setup({ options: { allow_no_category: '' }, answers: { countCategories: 0 } });
    await none.service.createQuestion(none.req({ title: 'Title here' }));
  });
  test('a follow-on question links to its answer and tells that question\'s followers', async () => {
    const s = setup({ posts: { 20: { postid: '20', basetype: 'A', parentid: '1', userid: '9' }, 21: { postid: '21', basetype: 'Q' } } });
    await s.service.createQuestion(s.req({ title: 'Title here', followAnswerId: 20 }));
    expect(s.named('insertPost')[0][1].parentid).toBe('20');
    expect(s.named('eventCreateForEntity')[0].slice(1, 6)).toEqual(['Q', '1', '1', 100, 'F']);
    const notAnswer = setup({ posts: { 21: { postid: '21', basetype: 'Q' } } });
    await notAnswer.service.createQuestion(notAnswer.req({ title: 'Title here', followAnswerId: 21 }));
    expect(notAnswer.named('insertPost')[0][1].parentid).toBeNull();
  });
  test('the extra field is stored only when it is switched on', async () => {
    const s = setup({ options: { extra_field_active: '1' } });
    await s.service.createQuestion(s.req({ title: 'Title here', extra: ' more ' }));
    expect(s.named('setPostMeta')).toEqual([['setPostMeta', 100, 'qa_q_extra', 'more']]);
    const off = setup();
    await off.service.createQuestion(off.req({ title: 'Title here', extra: 'x' }));
    expect(off.names()).not.toContain('setPostMeta');
  });
  test('a moderated question is queued: counted as queued, not indexed or announced, and the admin told', async () => {
    const s = setup({ options: { moderate_anon_post: '1', moderate_notify_admin: '1', feedback_email: 'admin@x.test' }, answers: { findUserEmailHandle: null } });
    expect(await s.service.createQuestion(s.req({ title: 'Title here', name: ' Guest ' }, { cookieid: '123' }, 'none'))).toEqual({ id: 100, type: 'Q_QUEUED', queued: true, cookieid: undefined });
    expect(s.named('insertPost')[0][1]).toMatchObject({ type: 'Q_QUEUED', userid: null, cookieid: '123', name: 'Guest' });
    expect(s.names()).toContain('queuedcountUpdate');
    expect(s.names()).not.toContain('addTitleWords');
    expect(s.names()).not.toContain('qcountUpdate');
    expect(s.names()).not.toContain('eventCreateForEntity');
    expect(s.named('cookieWritten')).toEqual([['cookieWritten', '123', '1.2.3.4']]);
    expect(s.afterCommit).toHaveLength(1);
  });
  test('an anonymous visitor without a known cookie gets a new one', async () => {
    const s = setup();
    expect((await s.service.createQuestion(s.req({ title: 'Title here' }, { cookieid: '999' }, 'none'))).cookieid).toBe('888');
  });
  test.each([
    ['not allowed to ask', { options: { permit_post_q: '100' } }, {}, 403, 'no_permission'],
    ['signed out where asking needs a login', { options: { permit_post_q: '120' } }, { token: 'none' }, 401, 'unauthenticated'],
    ['over the question limit', { answers: { findLimits: { user: { period: 2000, count: 10 } } } }, {}, 429, 'ask_limit'],
  ])('refused when %s', async (label, args, { token = 'ok' }, status, code) => {
    const s = setup(args);
    await rejectsWith(s.service.createQuestion(s.req({ title: 'Title here' }, {}, token)), status, code);
    expect(s.names()).not.toContain('insertPost');
  });
  test('input errors are reported together; a duplicate of a recent question is refused', async () => {
    const s = setup();
    await rejectsWith(s.service.createQuestion(s.req({ title: 'Hi', tags: ['a', 'b', 'c', 'd', 'e', 'f'] })), 400, 'validation_failed', { title: 'min_length', tags: 'max_tags' });
    const dup = setup({ answers: { recentQuestions: [{ title: 'A Good Question', content: 'Text!' }] } });
    await rejectsWith(dup.service.createQuestion(dup.req({ title: 'a good question', content: 'text' })), 409, 'duplicate_content');
    await dup.service.createQuestion(dup.req({ title: 'a good question', content: 'other text' }));
  });
  test('a category the user may not post in', async () => {
    const s = setup({ options: { permit_post_q: '100' }, user: { ...ME, level: '0' }, answers: { categoryPath: [{ categoryid: 3 }] } });
    await rejectsWith(s.service.createQuestion(s.req({ title: 'Title here', categoryid: 3 })), 403, 'no_permission');
  });
});

describe('answering', () => {
  const q1 = question();
  test('the answer, the question\'s answer count and hotness, the site counts, points, limits, event and email', async () => {
    const s = setup({ posts: { 1: q1 }, answers: { findUserEmailHandle: null } });
    expect(await s.service.createAnswer(s.req({ content: 'An answer' }, { questionid: 1 }))).toEqual({ id: 100, type: 'A', queued: false, cookieid: undefined });
    expect(s.named('insertPost')[0][1]).toEqual({ type: 'A', parentid: '1', userid: 5, cookieid: null, ip: '1.2.3.4', title: null, content: 'An answer', format: '', tagstring: null, notify: null, categoryid: '3', name: null });
    expect(s.names().filter(n => /count|Hotness|Points|^add|^event|increment|Written/i.test(n) && n !== 'updateWordCounts')).toEqual([
      'addTitleWords', 'addContentWords', 'addTagWords', 'addPostTags', 'acountUpdateForQ', 'updateHotness', 'acountUpdate', 'unaqcountUpdate', 'updatePoints',
      'incrementLimits', 'userWritten', 'eventCreateForEntity', 'eventCreateForEntity', 'eventCreateNotEntity',
    ]);
    expect(s.named('findPost')[0]).toEqual(['findPost', 1, { lock: true }]);
    expect(s.named('acountUpdateForQ')).toEqual([['acountUpdateForQ', '1', 1]]);
  });
  test('a question that already had answers stays out of the unanswered count; a hidden question\'s answer is not indexed', async () => {
    const s = setup({ posts: { 1: question({ acount: '2' }) } });
    await s.service.createAnswer(s.req({ content: 'An answer' }, { questionid: 1 }));
    expect(s.names()).not.toContain('unaqcountUpdate');
  });
  test.each([
    ['a missing question', { posts: {} }, 404, 'question_not_found'],
    ['a closed question', { posts: { 1: question({ closedbyid: '4' }) } }, 403, 'answer_not_allowed'],
    ['a question closed by its selected answer', { posts: { 1: question({ selchildid: '2' }) }, options: { do_close_on_select: '1' } }, 403, 'answer_not_allowed'],
    ['your own question when self-answers are off', { posts: { 1: question({ userid: '5' }) }, options: { allow_self_answer: '' } }, 403, 'answer_not_allowed'],
    ['a second answer when multiple answers are off', { posts: { 1: q1 }, children: { 1: [{ type: 'A', userid: '5', hidden: 0, content: 'x' }] }, options: { allow_multi_answers: '' } }, 403, 'answer_not_allowed'],
    ['below the level to answer', { posts: { 1: q1 }, options: { permit_post_a: '100' } }, 403, 'answer_not_allowed'],
    ['over the answer limit', { posts: { 1: q1 }, answers: { findLimits: { ip: { period: 2000, count: 10 } } } }, 429, 'answer_limit'],
    ['before confirming the email', { posts: { 1: q1 }, user: { ...ME, flags: '0' }, options: { permit_post_a: '110', confirm_user_emails: '1' } }, 403, 'answer_must_confirm'],
  ])('refused on %s', async (label, args, status, code) => {
    const s = setup(args);
    await rejectsWith(s.service.createAnswer(s.req({ content: 'An answer' }, { questionid: 1 })), status, code);
    expect(s.names()).not.toContain('insertPost');
  });
  test('content too short, or the same as a visible answer, is refused', async () => {
    const s = setup({ posts: { 1: q1 }, children: { 1: [{ type: 'A', userid: '9', hidden: 0, content: 'Same Answer' }, { type: 'A_HIDDEN', userid: '9', hidden: 1, content: 'Hidden one' }] } });
    await rejectsWith(s.service.createAnswer(s.req({ content: 'x' }, { questionid: 1 })), 400, 'validation_failed', { content: 'min_length' });
    await rejectsWith(s.service.createAnswer(s.req({ content: 'same answer!' }, { questionid: 1 })), 409, 'duplicate_content');
    await s.service.createAnswer(s.req({ content: 'hidden one' }, { questionid: 1 }));
  });
  test('a moderated answer is queued and the admin told', async () => {
    const s = setup({ posts: { 1: q1 }, options: { moderate_anon_post: '1', moderate_notify_admin: '1', feedback_email: 'a@x.test' } });
    expect(await s.service.createAnswer(s.req({ content: 'An answer' }, { questionid: 1 }, 'none'))).toMatchObject({ type: 'A_QUEUED', queued: true, cookieid: '888' });
    expect(s.names()).toContain('queuedcountUpdate');
    expect(s.names()).not.toContain('acountUpdate');
    expect(s.names()).not.toContain('eventCreateForEntity');
    expect(s.afterCommit).toHaveLength(1);
  });
  test('no question ID', async () => {
    const s = setup();
    await rejectsWith(s.service.createAnswer(s.req({ content: 'x' }, { questionid: null })), 404, 'question_not_found');
  });
});

describe('commenting', () => {
  const q1 = question({ userid: '9' });
  const a2 = { postid: '2', type: 'A', basetype: 'A', parentid: '1', userid: '8', cookieid: null, hidden: 0, queued: 0, categoryids: '', content: 'answer', format: '', notify: null };
  test('on an answer: the comment, its index entry, points, count, and events for the thread and the answer\'s author', async () => {
    const thread = [{ type: 'C', basetype: 'C', userid: '7', hidden: 0, content: 'first' }, { type: 'C', basetype: 'C', userid: '5', hidden: 0, content: 'mine' }, { type: 'C_HIDDEN', basetype: 'C', userid: '6', hidden: 1, content: 'gone' }];
    const s = setup({ posts: { 1: q1, 2: a2 }, children: { 2: thread }, answers: { findUserEmailHandle: null } });
    expect(await s.service.createComment(s.req({ content: 'A comment' }, { parentid: 2 }))).toEqual({ id: 100, type: 'C', queued: false, cookieid: undefined });
    expect(s.named('insertPost')[0][1]).toMatchObject({ type: 'C', parentid: '2', categoryid: '3' });
    expect(s.named('updatePoints')[0].slice(1, 3)).toEqual([5, ['cposts']]);
    expect(s.names()).toContain('ccountUpdate');
    expect(s.named('eventCreateNotEntity').map(c => c.slice(1, 6))).toEqual([[7, '1', 100, 'F', 5], ['8', '1', 100, 'N', 5]]);
    expect(s.named('eventCreateForEntity').map(c => c.slice(1, 6))).toEqual([['Q', '1', '1', 100, 'N'], ['U', 5, '1', 100, 'N']]);
  });
  test('on a question: the C_FOR_Q update, and the question\'s author is not told twice if they commented', async () => {
    const s = setup({ posts: { 1: q1 }, children: { 1: [{ type: 'C', basetype: 'C', userid: '9', hidden: 0, content: 'asker comment' }] } });
    await s.service.createComment(s.req({ content: 'A comment' }, { parentid: 1 }));
    expect(s.named('eventCreateNotEntity').map(c => c.slice(1, 5))).toEqual([[9, '1', 100, 'F']]);
    expect(s.named('eventCreateForEntity').map(c => c[5])).toEqual(['U', 'U']);
  });
  test.each([
    ['a missing parent', { posts: {} }, 1, 404, 'post_not_found'],
    ['a comment as parent', { posts: { 4: { postid: '4', basetype: 'C' } } }, 4, 404, 'post_not_found'],
    ['a hidden answer', { posts: { 1: q1, 2: { ...a2, hidden: 1, type: 'A_HIDDEN' } } }, 2, 404, 'post_not_found'],
    ['comments on answers switched off', { posts: { 1: q1, 2: a2 }, options: { comment_on_as: '' } }, 2, 403, 'comment_not_allowed'],
    ['comments on questions switched off', { posts: { 1: q1 }, options: { comment_on_qs: '' } }, 1, 403, 'comment_not_allowed'],
    ['below the level to comment', { posts: { 1: q1 }, options: { permit_post_c: '100' } }, 1, 403, 'comment_not_allowed'],
    ['over the comment limit', { posts: { 1: q1 }, answers: { findLimits: { user: { period: 2000, count: 10 } } } }, 1, 429, 'comment_limit'],
  ])('refused on %s', async (label, args, parentid, status, code) => {
    const s = setup(args);
    await rejectsWith(s.service.createComment(s.req({ content: 'A comment' }, { parentid })), status, code);
    expect(s.names()).not.toContain('insertPost');
  });
  test('a duplicate of a visible comment on the same post is refused; too short too', async () => {
    const s = setup({ posts: { 1: q1 }, children: { 1: [{ type: 'C', basetype: 'C', userid: '7', hidden: 0, content: 'Same thing' }, { type: 'A', basetype: 'A', content: 'an answer' }] } });
    await rejectsWith(s.service.createComment(s.req({ content: 'same thing' }, { parentid: 1 })), 409, 'duplicate_content');
    await rejectsWith(s.service.createComment(s.req({ content: 'x' }, { parentid: 1 })), 400, 'validation_failed', { content: 'min_length' });
    await s.service.createComment(s.req({ content: 'an answer' }, { parentid: 1 }));
  });
  test('a moderated comment is queued and the admin told', async () => {
    const s = setup({ posts: { 1: q1 }, options: { moderate_anon_post: '1', moderate_notify_admin: '1', feedback_email: 'a@x.test' } });
    expect(await s.service.createComment(s.req({ content: 'A comment' }, { parentid: 1 }, 'none'))).toMatchObject({ type: 'C_QUEUED', queued: true });
    expect(s.names()).not.toContain('ccountUpdate');
    expect(s.afterCommit).toHaveLength(1);
  });
});
