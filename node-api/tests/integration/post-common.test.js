// src/services/post-common.js: the pieces shared by the posting services.
// postRules() and the basic filter are held to Q2A's own qa_page_q_post_rules() and qa_filter_basic, run in
// the PHP container over a grid of posts, viewers and options (tests/fixtures/php-post-rules.php,
// scripts/php-fixtures.sh). The other helpers are driven directly with a recording fake repository.
const php = require('../fixtures/php-post-rules-outputs.json');
const common = require('../../src/services/post-common');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const { createPostHelpers, filterQuestion, filterChild } = common;
const helpers = createPostHelpers({ identify: async token => (token === 'ok' ? { id: 5 } : null) });
const ctxFor = (options, user, cookieid, q) => ({ q, options, user, userid: user ? Number(user.userid) : null, cookieid: cookieid ?? null, ip: '9.9.9.9', period: 2000 });

test('postRules() gives every rule qa_page_q_post_rules() gives', () => {
  const wrong = [];
  for (const [setName, viewerName, postName, bits] of php.rules) {
    const options = optionsWith({ ...php.baseOptions, ...php.optionSets[setName] });
    const [user, cookie] = php.viewers[viewerName];
    const [post, parent, siblings, children] = php.posts[postName];
    const rules = helpers.postRules(ctxFor(options, user, cookie), { ...post }, parent, siblings, children);
    const node = php.keys.map(key => (rules[key] ? '1' : '0')).join('');
    if (node !== bits) {
      const differ = php.keys.filter((key, i) => node[i] !== bits[i]).map(key => `${key}: php ${bits[php.keys.indexOf(key)]}, node ${node[php.keys.indexOf(key)]}`);
      wrong.push({ setName, viewerName, postName, differ });
    }
  }
  expect(wrong).toEqual([]);
  expect(php.rules.length).toBeGreaterThan(1000);
});

describe('qa_filter_basic', () => {
  const { sets, titles, texts, tagSets, emails } = php.filterInputs;
  // PHP reports language strings; Node reports codes the bridge turns back into those strings.
  const codesFor = message => {
    if (message.startsWith('Please provide more information')) return ['min_length', 'required'];
    if (message.startsWith('Maximum length')) return ['max_length'];
    if (message.startsWith('Email is invalid')) return ['invalid'];
    if (message.startsWith('Please provide at least')) return ['min_tags'];
    if (message.startsWith('A maximum of')) return ['max_tags'];
    throw new Error(`unmapped message ${message}`);
  };
  const compare = (phpErrors, nodeErrors, renameText) => {
    const expected = {};
    for (const [field, message] of Object.entries(phpErrors)) expected[field] = codesFor(message);
    // A question's content that is too short is PHP's "text" error, shown on the content field.
    if (renameText && expected.text) { expected.content = expected.text; delete expected.text; }
    const ok = Object.keys(expected).sort().join() === Object.keys(nodeErrors).sort().join() && Object.entries(nodeErrors).every(([f, code]) => expected[f]?.includes(code));
    return ok ? null : { php: phpErrors, node: nodeErrors };
  };
  const optionsFor = s => optionsWith({ ...php.baseOptions, ...sets[s] });
  test('questions', () => {
    const wrong = [];
    for (const [s, ti, xi, gi, ei, errors] of php.filterQuestion) {
      const [notify, email] = emails[ei];
      const input = ti < 0 ? { title: 'A good long title here', content: 'content', text: 'content', notify, email }
        : { title: titles[ti], content: texts[xi], text: texts[xi], notify, email, ...(tagSets[gi] ? { tags: tagSets[gi] } : {}) };
      const diff = compare(errors, filterQuestion(input, optionsFor(s)), true);
      if (diff) wrong.push({ s, ti, xi, gi, ei, ...diff });
    }
    expect(wrong).toEqual([]);
  });
  test.each([['Answer', 'min_len_a_content'], ['Comment', 'min_len_c_content']])('%ss', (kind, minOption) => {
    const wrong = [];
    for (const [s, xi, ei, errors] of php[`filter${kind}`]) {
      const [notify, email] = emails[ei];
      const diff = compare(errors, filterChild({ content: texts[xi], text: texts[xi], notify, email }, minOption, optionsFor(s)), false);
      if (diff) wrong.push({ s, xi, ei, ...diff });
    }
    expect(wrong).toEqual([]);
  });
  test('only the fields present are checked', () => {
    expect(filterQuestion({}, optionsWith({ min_len_q_title: '10', min_len_q_content: '10' }))).toEqual({});
    expect(filterChild({}, 'min_len_a_content', optionsWith({ min_len_a_content: '10' }))).toEqual({});
    expect(filterQuestion({ title: '' }, optionsWith({ min_len_q_title: '1', max_len_q_title: '5' }))).toEqual({ title: 'required' });
  });
});

describe('request input', () => {
  test('permitFailure() maps permission errors to responses', () => {
    expect(['login', 'confirm', 'approve', 'limit', 'level', 'userblock', 'ipblock'].map(e => common.permitFailure(e, 'answer'))).toEqual([
      [401, 'unauthenticated'], [403, 'answer_must_confirm'], [403, 'answer_must_be_approved'], [429, 'answer_limit'],
      [403, 'no_permission'], [403, 'no_permission'], [403, 'no_permission'],
    ]);
  });
  test('stringField() takes text as qa_post_text() reads it, and refuses anything else', () => {
    expect(common.stringField({ a: '  x\r\ny ' }, 'a')).toBe('x\ny');
    expect(common.stringField({}, 'a')).toBeNull();
    expect(common.stringField({ a: null }, 'a')).toBeNull();
    for (const bad of [5, true, ['x'], { x: 1 }]) expect(() => common.stringField({ a: bad }, 'a')).toThrow(expect.objectContaining({ status: 400, code: 'invalid_input', fields: { a: 'invalid' } }));
  });
  test('readContent(): plain text or HTML, emoji removed, and the text the search index sees', () => {
    expect(common.readContent({ content: ' Hi 😀 ' })).toEqual({ content: 'Hi ', format: '', text: 'Hi ' });
    expect(common.readContent({ content: '<p>Hi <b>there</b></p>', format: 'html' })).toEqual({ content: '<p>Hi <b>there</b></p>', format: 'html', text: 'Hi there' });
    expect(common.readContent({})).toEqual({ content: '', format: '', text: '' });
    expect(() => common.readContent({ format: 'markdown' })).toThrow(expect.objectContaining({ fields: { format: 'invalid' } }));
  });
  test('readCommon(): notify must be a boolean; a name only when anonymous naming is on', () => {
    expect(common.readCommon({ content: 'c', notify: true, email: ' a@b.test ', name: ' Ann ' }, optionsWith({ allow_anonymous_naming: '1' })))
      .toEqual({ content: 'c', format: '', text: 'c', notify: true, email: 'a@b.test', name: 'Ann' });
    expect(common.readCommon({ content: 'c', name: 'Ann' }, optionsWith({}))).toMatchObject({ notify: false, email: null, name: null });
    expect(() => common.readCommon({ notify: 'yes' }, optionsWith({}))).toThrow(expect.objectContaining({ fields: { notify: 'invalid' } }));
  });
  test('readId(): a positive whole number or nothing', () => {
    expect([common.readId(undefined, 'x'), common.readId(null, 'x'), common.readId(1, 'x'), common.readId(99, 'x')]).toEqual([null, null, 1, 99]);
    for (const bad of [0, -1, 1.5, '3']) expect(() => common.readId(bad, 'x')).toThrow(expect.objectContaining({ fields: { x: 'invalid' } }));
  });
  test('sameWords() compares the words, ignoring case and punctuation', () => {
    expect(common.sameWords('Hello, World!', 'hello world')).toBe(true);
    expect(common.sameWords('Hello World', 'Hello Word')).toBe(false);
  });
  test('the limits and update codes are Q2A\'s', () => {
    expect(common.MAX).toEqual({ TITLE: 800, CONTENT: 12000, TAGS: 800, EMAIL: 80 });
    expect(common.UPDATE).toEqual({ CATEGORY: 'A', CLOSED: 'C', CONTENT: 'E', PARENT: 'M', SELECTED: 'S', TAGS: 'T', TYPE: 'Y', VISIBLE: 'H', FOLLOWS: 'F', C_FOR_Q: 'U', C_FOR_A: 'N' });
  });
});

describe('helpers', () => {
  test('withIdentity() looks the session up once, before the transaction', async () => {
    expect(await helpers.withIdentity({ token: 'ok', x: 1 })).toEqual({ token: 'ok', x: 1, identity: { id: 5 } });
    expect(await helpers.withIdentity({ token: 'bad' })).toEqual({ token: 'bad', identity: null });
    const given = { identity: null, token: 'ok' };
    expect(await helpers.withIdentity(given)).toBe(given);
  });
  test('context() loads the options and the user, and sets the user-updates limit', async () => {
    const fake = fakeRepository({ loadOptions: optionsWith({ max_store_user_updates: '50' }, 7200 * 1000), findActor: { userid: '5', level: 0 } });
    const ctx = await helpers.context(fake.q, { identity: { id: 5 }, ip: 'ip' });
    expect(ctx).toMatchObject({ userid: 5, cookieid: null, ip: 'ip', period: 2000, user: { userid: '5' } });
    expect(fake.named('setMaxStoreUserUpdates', 'findActor')).toEqual([['setMaxStoreUserUpdates', '50'], ['findActor', 5]]);
    const anon = await helpers.context(fakeRepository({ loadOptions: optionsWith({}) }).q, { identity: null, cookieid: '77', ip: 'ip' });
    expect(anon).toMatchObject({ user: null, userid: null, cookieid: '77' });
    await expect(helpers.context(fake.q, { ip: 'ip' })).rejects.toThrow('withIdentity');
  });
  test('postCookie(): a user needs none; a visitor keeps a known cookie or gets a new one', async () => {
    const fake = fakeRepository({ cookieExists: id => id === '123', createCookie: '999' });
    expect(await helpers.postCookie({ ...ctxFor(optionsWith(), { userid: 5 }, '1', fake.q) })).toEqual({ cookieid: '1', created: false });
    expect(await helpers.postCookie(ctxFor(optionsWith(), null, '123', fake.q))).toEqual({ cookieid: '123', created: false });
    for (const cookie of ['456', null, 'abc', '1'.repeat(21)]) expect(await helpers.postCookie(ctxFor(optionsWith(), null, cookie, fake.q))).toEqual({ cookieid: '999', created: true });
    expect(fake.named('createCookie')[0]).toEqual(['createCookie', '9.9.9.9']);
    expect(fake.named('cookieExists').map(c => c[1])).toEqual(['123', '456']);
  });
  test('checkQuestionPage(): missing, not a question, not viewable, or not permitted', () => {
    const options = optionsWith({ permit_hide_show: '70', permit_moderate: '100', permit_view_q_page: '150' });
    const ctx = ctxFor(options, { userid: 5, level: 0, flags: 0 }, null);
    expect(() => helpers.checkQuestionPage(ctx, undefined)).toThrow(expect.objectContaining({ status: 404, code: 'question_not_found' }));
    expect(() => helpers.checkQuestionPage(ctx, { basetype: 'A' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => helpers.checkQuestionPage(ctx, { basetype: 'Q', hidden: 1, userid: 9, categoryids: '' })).toThrow(expect.objectContaining({ status: 403, code: 'question_not_viewable' }));
    expect(() => helpers.checkQuestionPage(ctxFor(optionsWith({ permit_view_q_page: '120' }), null, null), { basetype: 'Q', hidden: 0, queued: 0, categoryids: '' })).toThrow(expect.objectContaining({ status: 403, code: 'no_permission' }));
    expect(() => helpers.checkQuestionPage(ctx, { basetype: 'Q', hidden: 0, queued: 0, userid: 9, categoryids: '' })).not.toThrow();
    // its own author sees a queued question; moderators see anyone's
    expect(helpers.viewable(ctx, { queued: 1, userid: 5, categoryids: '' })).toBe(true);
    expect(helpers.viewable(ctx, { queued: 1, userid: 9, categoryids: '' })).toBe(false);
    expect(helpers.viewable(ctxFor(options, { userid: 6, level: 100, flags: 0 }, null), { queued: 1, userid: 9, categoryids: '' })).toBe(true);
    expect(helpers.viewable(ctx, { hidden: 1, userid: 5, categoryids: '' })).toBe(true);
  });
  test('indexPost(): each word once per title, counted in the content, tags as words and whole tags', async () => {
    const fake = fakeRepository({ wordMapToIdsAdd: words => new Map(words.filter(w => w !== 'skip').map((w, i) => [w, i + 1])) });
    await helpers.indexPost(fake.q, 9, 'Q', 9, 'Big big title skip', 'one two two skip', 'tag-a,b');
    const [[, words]] = fake.named('wordMapToIdsAdd');
    expect(words).toEqual(['big', 'title', 'skip', 'one', 'two', 'tag', 'a', 'b', 'tag-a']);
    expect(fake.named('addTitleWords', 'addContentWords', 'addTagWords', 'addPostTags')).toEqual([
      ['addTitleWords', 9, [1, 2]], ['addContentWords', 9, 'Q', 9, [[3, 1], [4, 2]]], ['addTagWords', 9, [5, 6, 7]], ['addPostTags', 9, [8, 7]],
    ]);
    expect(fake.named('updateWordCounts')).toEqual([
      ['updateWordCounts', 'titlecount', 'qa_titlewords', [1, 2]], ['updateWordCounts', 'contentcount', 'qa_contentwords', [3, 4]],
      ['updateWordCounts', 'tagwordcount', 'qa_tagwords', [5, 6, 7]], ['updateWordCounts', 'tagcount', 'qa_posttags', [8, 7]],
    ]);
    const quiet = fakeRepository({ wordMapToIdsAdd: new Map() });
    await helpers.indexPost(quiet.q, 9, 'A', 3, null, '', null, { updateCounts: false });
    expect(quiet.names()).toEqual(['wordMapToIdsAdd', 'addTitleWords', 'addContentWords', 'addTagWords', 'addPostTags']);
  });
  test('unindexPost(): every index table, then its counts', async () => {
    const fake = fakeRepository({ indexedWordIds: table => [table.length] });
    await helpers.unindexPost(fake.q, 9);
    expect(fake.calls).toEqual([
      ['indexedWordIds', 'qa_titlewords', 9], ['deleteIndexed', 'qa_titlewords', 9], ['updateWordCounts', 'titlecount', 'qa_titlewords', [13]],
      ['indexedWordIds', 'qa_contentwords', 9], ['deleteIndexed', 'qa_contentwords', 9], ['updateWordCounts', 'contentcount', 'qa_contentwords', [15]],
      ['indexedWordIds', 'qa_tagwords', 9], ['deleteIndexed', 'qa_tagwords', 9], ['updateWordCounts', 'tagwordcount', 'qa_tagwords', [11]],
      ['indexedWordIds', 'qa_posttags', 9], ['deleteIndexed', 'qa_posttags', 9], ['updateWordCounts', 'tagcount', 'qa_posttags', [11]],
    ]);
  });
  test('eventForQUser(): the question, the acting user, and the other user unless they are the same', async () => {
    const fake = fakeRepository();
    await helpers.eventForQUser(fake.q, 1, 2, 'S', 5, 9);
    await helpers.eventForQUser(fake.q, 1, 2, 'S', 5, '5');
    await helpers.eventForQUser(fake.q, 1, 2, 'S', null, null);
    expect(fake.calls).toEqual([
      ['eventCreateForEntity', 'Q', 1, 1, 2, 'S', 5], ['eventCreateForEntity', 'U', 5, 1, 2, 'S', 5], ['eventCreateNotEntity', 9, 1, 2, 'S', 5],
      ['eventCreateForEntity', 'Q', 1, 1, 2, 'S', 5], ['eventCreateForEntity', 'U', 5, 1, 2, 'S', 5],
      ['eventCreateForEntity', 'Q', 1, 1, 2, 'S', null],
    ]);
  });
  test('reportWrite() and reportAction(): count the action, then the user\'s or visitor\'s last write', async () => {
    const fake = fakeRepository();
    const user = { ...ctxFor(optionsWith(), { userid: 5 }, null, fake.q) };
    const visitor = { ...ctxFor(optionsWith(), null, '77', fake.q) };
    await helpers.reportWrite(user, null, 'A');
    await helpers.reportWrite(visitor, '88', 'Q');
    await helpers.reportWrite({ ...visitor }, null, 'C');
    await helpers.reportAction(user, null);
    await helpers.reportAction(visitor, 'F');
    await helpers.reportAction({ ...visitor, cookieid: null }, null);
    expect(fake.calls).toEqual([
      ['incrementLimits', 5, '9.9.9.9', 'A', 2000], ['userWritten', 5, '9.9.9.9'],
      ['incrementLimits', null, '9.9.9.9', 'Q', 2000], ['cookieWritten', '88', '9.9.9.9'],
      ['incrementLimits', null, '9.9.9.9', 'C', 2000],
      ['userWritten', 5, '9.9.9.9'],
      ['incrementLimits', null, '9.9.9.9', 'F', 2000], ['cookieWritten', '77', '9.9.9.9'],
    ]);
  });
  describe('checkCaptcha() (qa_user_captcha_reason())', () => {
    const captcha = { captcha_module: 'reCAPTCHA', recaptcha_public_key: 'p', recaptcha_private_key: 'k' };
    const check = (options, user, userlevel = null) => helpers.checkCaptcha(ctxFor(optionsWith({ ...captcha, ...options }), user, null), userlevel, 'captcha_on_anon_post');
    test('needed for anonymous posts when that option is on', () => {
      expect(() => check({ captcha_on_anon_post: '1' }, null)).toThrow(expect.objectContaining({ status: 400, code: 'captcha_required' }));
      expect(() => check({}, null)).not.toThrow();
    });
    test('needed for unapproved or unconfirmed users when those options are on', () => {
      expect(() => check({ moderate_users: '1', captcha_on_unapproved: '1' }, { userid: 5, level: 0, flags: 1 })).toThrow();
      expect(() => check({ moderate_users: '1' }, { userid: 5, level: 0, flags: 1 })).not.toThrow();
      expect(() => check({ confirm_user_emails: '1', captcha_on_unconfirmed: '1' }, { userid: 5, level: 0, flags: 0 })).toThrow();
      expect(() => check({ confirm_user_emails: '1', captcha_on_unconfirmed: '1' }, { userid: 5, level: 0, flags: 1 })).not.toThrow();
    });
    test('never for approved users, at their level or the category level, nor without a working captcha', () => {
      const all = { captcha_on_anon_post: '1', moderate_users: '1', captcha_on_unapproved: '1' };
      expect(() => check(all, { userid: 5, level: 10, flags: 0 })).not.toThrow();
      expect(() => check(all, { userid: 5, level: 0, flags: 0 }, 10)).not.toThrow();
      expect(() => check(all, { userid: 5, level: 0, flags: 0 }, 9)).toThrow();
      expect(() => helpers.checkCaptcha(ctxFor(optionsWith({ ...all, recaptcha_private_key: '' }), null, null), null, 'captcha_on_anon_post')).not.toThrow();
      expect(() => helpers.checkCaptcha(ctxFor(optionsWith({ ...all, captcha_module: '' }), null, null), null, 'captcha_on_anon_post')).not.toThrow();
    });
  });
  describe('permitEdit() (qa_page_q_permit_edit())', () => {
    const options = optionsWith({ permit_edit_q: '70', permit_retag_cat: '100', confirm_user_emails: '1', moderate_users: '1' }); // editors edit, experts retag
    const run = (user, rules, second) => () => helpers.permitEdit(ctxFor(options, user, null), {}, { isbyuser: false, userlevel: null, ...rules }, 'permit_edit_q', second);
    test('authors always may; others need the permission', () => {
      expect(run({ userid: 5, level: 0, flags: 1 }, { isbyuser: true })).not.toThrow();
      expect(run({ userid: 5, level: 70, flags: 1 }, {})).not.toThrow();
      expect(run({ userid: 5, level: 0, flags: 1 }, {})).toThrow(expect.objectContaining({ status: 403, code: 'no_permission' }));
      expect(run(null, {})).toThrow(expect.objectContaining({ status: 401, code: 'unauthenticated' }));
    });
    test('the second permission (retagging) is enough when the first fails on level', () => {
      expect(run({ userid: 5, level: 20, flags: 1 }, {}, 'permit_retag_cat')).not.toThrow();
      expect(run({ userid: 5, level: 10, flags: 1 }, {}, 'permit_retag_cat')).toThrow(expect.objectContaining({ code: 'no_permission' }));
    });
    test('an unconfirmed author is told to confirm', () => {
      const confirm = optionsWith({ permit_edit_q: '110', confirm_user_emails: '1' });
      expect(() => helpers.permitEdit(ctxFor(confirm, { userid: 5, level: 0, flags: 0 }, null), {}, { isbyuser: false, userlevel: null }, 'permit_edit_q'))
        .toThrow(expect.objectContaining({ status: 403, code: 'edit_must_confirm' }));
    });
    test('a confirm error on the first is replaced by the second\'s answer only when that one passes', () => {
      const opts = optionsWith({ permit_edit_q: '110', permit_retag_cat: '120', confirm_user_emails: '1' });
      expect(() => helpers.permitEdit(ctxFor(opts, { userid: 5, level: 0, flags: 0 }, null), {}, { isbyuser: false, userlevel: null }, 'permit_edit_q', 'permit_retag_cat')).not.toThrow();
      const opts2 = optionsWith({ permit_edit_q: '110', permit_retag_cat: '100', confirm_user_emails: '1' });
      expect(() => helpers.permitEdit(ctxFor(opts2, { userid: 5, level: 0, flags: 0 }, null), {}, { isbyuser: false, userlevel: null }, 'permit_edit_q', 'permit_retag_cat'))
        .toThrow(expect.objectContaining({ code: 'edit_must_confirm' }));
    });
  });

  describe('setSelchildid() (qa_question_set_selchildid())', () => {
    const answers = [{ postid: 20, userid: 7 }, { postid: 21, userid: 8 }];
    const run = async (question, selchildid, options = {}, actor) => {
      const fake = fakeRepository({ findUserEmailHandle: null });
      const ctx = { ...ctxFor(optionsWith(options), { userid: 5, handle: 'me' }, null, fake.q) };
      await helpers.setSelchildid(ctx, { postid: 1, userid: 9, closedbyid: null, selchildid: null, title: 'T', ...question }, selchildid, answers, actor);
      return fake;
    };
    test('selecting an answer: the question, both authors\' points, the count, the events and the actor\'s write', async () => {
      const fake = await run({}, 20);
      expect(fake.calls.map(c => c.slice(0, 3))).toEqual([
        ['setSelchildid', 1, 20], ['updatePoints', 9, ['aselects']], ['unselqcountUpdate', -1], ['updatePoints', 7, ['aselecteds']], ['userWritten', 5, '9.9.9.9'],
        ['eventCreateForEntity', 'Q', 1], ['eventCreateForEntity', 'U', 5], ['eventCreateNotEntity', 7, 1],
      ]);
      expect(fake.named('setSelchildid')[0][3]).toEqual({ userid: 5, ip: '9.9.9.9' });
    });
    test('changing the selection unselects the old answer first', async () => {
      const fake = await run({ selchildid: '20' }, 21);
      expect(fake.named('unselqcountUpdate', 'updatePoints').map(c => c.slice(1, 3))).toEqual([[9, ['aselects']], [1, undefined], [7, ['aselecteds']], [-1, undefined], [8, ['aselecteds']]]);
    });
    test('unselecting, with no actor (a hidden or converted answer): nothing is recorded for a user', async () => {
      const fake = await run({ selchildid: '20' }, null, {}, null);
      expect(fake.named('setSelchildid')[0]).toEqual(['setSelchildid', 1, null, null]);
      expect(fake.names()).not.toContain('userWritten');
      expect(fake.names()).not.toContain('eventCreateForEntity');
    });
    test('an old selection that is not among the answers is not unselected', async () => {
      const fake = await run({ selchildid: '99' }, null);
      expect(fake.names()).not.toContain('unselqcountUpdate');
    });
    test('with do_close_on_select, selecting closes the question and unselecting reopens it', async () => {
      const close = await run({}, 20, { do_close_on_select: '1' });
      expect(close.named('setClosed')).toEqual([['setClosed', 1, null, { userid: 5, ip: '9.9.9.9' }]]);
      expect(close.named('eventCreateForEntity').map(c => c[5])).toEqual(['S', 'S', 'C', 'C']);
      const reopen = await run({ selchildid: '20' }, null, { do_close_on_select: '1' });
      expect(reopen.named('setClosed')).toEqual([['setClosed', 1, null, { userid: 5, ip: '9.9.9.9' }]]);
      // a question closed some other way stays closed
      const closedOtherwise = await run({ selchildid: '20', closedbyid: '3' }, null, { do_close_on_select: '1' });
      expect(closedOtherwise.named('setClosed')).toEqual([]);
      const alreadyClosed = await run({ closedbyid: '3' }, 20, { do_close_on_select: '1' });
      expect(alreadyClosed.named('setClosed')).toEqual([]);
    });
    test('the answer\'s author is emailed', async () => {
      const fake = fakeRepository({ findUserEmailHandle: { email: 'seven@x.test', handle: 'seven' } });
      const ctx = { ...ctxFor(optionsWith({}), { userid: 5, handle: 'me' }, null, fake.q) };
      await helpers.setSelchildid(ctx, { postid: 1, userid: 9, closedbyid: null, selchildid: null, title: 'T' }, 20, [{ postid: 20, userid: 7, notify: '@' }]);
      expect(fake.afterCommit).toHaveLength(1);
    });
  });
});

test('rejectsWith is used by the other service tests', async () => {
  await rejectsWith(Promise.reject(Object.assign(new Error('x'), { status: 400, code: 'c' })), 400, 'c');
});
