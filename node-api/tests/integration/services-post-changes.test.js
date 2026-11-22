// Changing posts (services/post-changes.js), driven directly against a fake question page: selecting,
// closing, reopening, hiding and moderating, deleting, claiming and flagging. Each test checks the decision
// and the writes that matter; the parity suites hold the full set of writes to the PHP site.
const { createPostChangeService } = require('../../src/services/post-changes');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const OPTIONS = {
  permit_view_q_page: '150', permit_post_q: '150', permit_post_a: '150', permit_post_c: '150', permit_edit_q: '70', permit_edit_a: '100', permit_edit_c: '70',
  permit_retag_cat: '70', permit_flag: '110', permit_hide_show: '70', permit_close_q: '70', permit_moderate: '100', permit_select_a: '100',
  permit_delete_hidden: '40', allow_close_questions: '1', allow_close_own_questions: '1', allow_self_answer: '1', allow_multi_answers: '1',
  comment_on_qs: '1', comment_on_as: '1', flagging_of_posts: '1', flagging_hide_after: '3', flagging_notify_first: '1', flagging_notify_every: '2',
  max_rate_user_flags: '10', max_rate_ip_flags: '10', max_rate_user_qs: '10', max_rate_ip_qs: '10', max_rate_user_as: '10', max_rate_ip_as: '10',
  max_rate_user_cs: '10', max_rate_ip_cs: '10', tags_or_categories: 't', site_url: 'http://site.test/', neat_urls: '1', max_store_user_updates: '50',
};
const USERS = { 5: { userid: '5', handle: 'asker', level: '0', flags: '1', points: '0' }, 6: { userid: '6', handle: 'mod', level: '80', flags: '1', points: '0' }, 7: { userid: '7', handle: 'other', level: '0', flags: '1', points: '0' } };
const base = { hidden: 0, queued: 0, cookieid: null, lastuserid: null, closedbyid: null, selchildid: null, flagcount: '0', categoryid: null, categoryids: '', updated: null, netvotes: '0', format: '', name: null, notify: null, tags: '' };
const Q = changes => ({ ...base, postid: '1', type: 'Q', basetype: 'Q', parentid: null, userid: '5', title: 'Question title', content: 'question', acount: '2', amaxvote: '1', ...changes });
const A = (id, changes) => ({ ...base, postid: String(id), type: 'A', basetype: 'A', parentid: '1', userid: '7', content: `answer ${id}`, ...changes });
const C = (id, parentid, changes) => ({ ...base, postid: String(id), type: 'C', basetype: 'C', parentid: String(parentid), userid: '7', content: `comment ${id}`, ...changes });

function setup({ posts = [Q(), A(2), A(3, { userid: '5' }), C(4, 2)], options = {}, userflag = 0, answers = {}, duplicates = [] } = {}) {
  const byId = new Map(posts.map(p => [Number(p.postid), p]));
  const fake = fakeRepository({
    loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => USERS[id] ?? null,
    findPost: id => byId.get(Number(id)), findChildren: id => posts.filter(p => String(p.parentid) === String(id)), findDuplicates: duplicates,
    userFlag: userflag, findLimits: {}, filterQuestionIds: ids => ids.filter(id => byId.get(id)?.basetype === 'Q'), insertPost: 90, postUserVotes: [],
    getCategoryPath: [], findHandle: 'someone', wordMapToIdsAdd: new Map(), wordMapToIds: new Map(), indexedWordIds: [], userflagsClearAll: 2, ...answers,
  });
  const service = createPostChangeService(fake.repository, { identify: async token => (token in USERS ? { id: Number(token) } : null) });
  const req = (token, ids, body) => ({ token, ip: '1.2.3.4', cookieid: null, body, ...ids });
  return { ...fake, service, req };
}

describe('selecting the best answer', () => {
  test('the asker selects and unselects an answer', async () => {
    const s = setup();
    expect(await s.service.selectAnswer(s.req('5', { questionid: 1 }, { answerId: 2 }))).toEqual({ id: '1', selectedAnswerId: 2 });
    expect(s.named('setSelchildid')[0].slice(1, 3)).toEqual(['1', 2]);
    const un = setup({ posts: [Q({ selchildid: '2' }), A(2)] });
    expect(await un.service.selectAnswer(un.req('5', { questionid: 1 }, { answerId: null }))).toEqual({ id: '1', selectedAnswerId: null });
    expect(un.named('setSelchildid')[0].slice(1, 3)).toEqual(['1', null]);
    const nothing = setup();
    await nothing.service.selectAnswer(nothing.req('5', { questionid: 1 }, {}));
    expect(nothing.names()).not.toContain('setSelchildid');
  });
  test.each([
    ['someone else', '7', { answerId: 2 }, 1, 403, 'select_not_allowed'],
    ['an answer of another question', '5', { answerId: 99 }, 1, 404, 'answer_not_found'],
    ['an answer ID that is not a number', '5', { answerId: '2' }, 1, 400, 'invalid_input'],
    ['an answer instead of a question', '5', { answerId: 2 }, 2, 404, 'question_not_found'],
    ['a post that does not exist', '5', { answerId: 2 }, 50, 404, 'post_not_found'],
  ])('refused for %s', async (label, token, body, questionid, status, code) => {
    const s = setup();
    await rejectsWith(s.service.selectAnswer(s.req(token, { questionid }, body)), status, code);
    expect(s.names()).not.toContain('setSelchildid');
  });
});

describe('closing and reopening', () => {
  test('a link to another question closes as a duplicate of it', async () => {
    const s = setup({ posts: [Q(), Q({ postid: '8', title: 'Original' })] });
    expect(await s.service.closeQuestion(s.req('5', { questionid: 1 }, { details: ' http://site.test/8/original ' }))).toEqual({ id: '1', closedBy: { duplicateOf: 8 } });
    expect(s.named('setClosed')).toEqual([['setClosed', '1', 8, { userid: 5, ip: '1.2.3.4' }]]);
    expect(s.named('filterQuestionIds')).toEqual([['filterQuestionIds', [8]]]);
  });
  test('any other text closes with a note', async () => {
    const s = setup();
    expect(await s.service.closeQuestion(s.req('5', { questionid: 1 }, { details: 'Solved elsewhere' }))).toEqual({ id: '1', closedBy: { note: 'Solved elsewhere' } });
    expect(s.named('insertPost')[0][1]).toMatchObject({ type: 'NOTE', parentid: '1', userid: 5, content: 'Solved elsewhere' });
    expect(s.named('setClosed')).toEqual([['setClosed', '1', 90, { userid: 5, ip: '1.2.3.4' }]]);
  });
  test.each([
    ['a link naming no question', 'http://site.test/77/none', 400, 'validation_failed'],
    ['a link to the question itself', 'http://site.test/1/self', 400, 'validation_failed'],
    ['a link naming two questions', 'http://site.test/?a=8&b=9', 400, 'validation_failed'],
    ['no details', '   ', 400, 'validation_failed'],
  ])('refused: %s', async (label, details, status, code) => {
    const s = setup({ posts: [Q(), Q({ postid: '8' }), Q({ postid: '9' })] });
    await rejectsWith(s.service.closeQuestion(s.req('5', { questionid: 1 }, { details })), status, code);
    expect(s.names()).not.toContain('setClosed');
  });
  test('only the asker (own questions allowed) or a moderator may close; never twice', async () => {
    await rejectsWith(setup().service.closeQuestion(setup().req('7', { questionid: 1 }, { details: 'x' })), 403, 'close_not_allowed');
    await rejectsWith(setup({ options: { allow_close_questions: '' } }).service.closeQuestion(setup().req('5', { questionid: 1 }, { details: 'x' })), 403, 'close_not_allowed');
    await rejectsWith(setup({ posts: [Q({ closedbyid: '3' })] }).service.closeQuestion(setup().req('6', { questionid: 1 }, { details: 'x' })), 403, 'close_not_allowed');
    await expect(setup().service.closeQuestion(setup().req('6', { questionid: 1 }, { details: 'x' }))).resolves.toBeTruthy();
    await rejectsWith(setup().service.closeQuestion(setup().req('5', { questionid: 2 }, { details: 'x' })), 404, 'question_not_found');
  });
  test('reopening clears the closure and deletes its note', async () => {
    const note = { ...base, postid: '30', type: 'NOTE', basetype: 'N', parentid: '1', userid: '5', content: 'n' };
    const s = setup({ posts: [Q({ closedbyid: '30', lastuserid: '5' }), note] });
    expect(await s.service.reopenQuestion(s.req('5', { questionid: 1 }))).toEqual({ id: '1' });
    expect(s.named('setClosed', 'deletePost')).toEqual([['setClosed', '1', null, { userid: 5, ip: '1.2.3.4' }], ['deletePost', '30']]);
    const dup = setup({ posts: [Q({ closedbyid: '8', lastuserid: '5' }), Q({ postid: '8' })] });
    await dup.service.reopenQuestion(dup.req('5', { questionid: 1 }));
    expect(dup.names()).not.toContain('deletePost');
    await rejectsWith(setup().service.reopenQuestion(setup().req('5', { questionid: 1 })), 403, 'reopen_not_allowed');
    await rejectsWith(setup().service.reopenQuestion(setup().req('5', { questionid: 2 })), 404, 'question_not_found');
  });
});

describe('hiding, reshowing and moderating', () => {
  test('the author hides their answer: hidden, unindexed, the question\'s counts recounted, the write recorded', async () => {
    const s = setup();
    expect(await s.service.setStatus(s.req('7', { postid: 2 }, { action: 'hide' }))).toEqual({ id: '2', type: 'A_HIDDEN' });
    expect(s.named('setType')).toEqual([['setType', '2', 'A_HIDDEN', { updatetype: 'H', userid: 7, ip: '1.2.3.4' }]]);
    expect(s.names()).toEqual(expect.arrayContaining(['deleteIndexed', 'userWritten', 'updatePoints']));
  });
  test('hiding the selected answer unselects it', async () => {
    const s = setup({ posts: [Q({ selchildid: '2' }), A(2)] });
    await s.service.setStatus(s.req('7', { postid: 2 }, { action: 'hide' }));
    expect(s.named('setSelchildid')[0].slice(1, 3)).toEqual(['1', null]);
  });
  test('reshowing; a moderated author\'s reshown post goes back to the queue', async () => {
    const hidden = [Q(), A(2, { type: 'A_HIDDEN', hidden: 1, lastuserid: '7' })];
    const s = setup({ posts: hidden });
    expect((await s.service.setStatus(s.req('7', { postid: 2 }, { action: 'reshow' }))).type).toBe('A');
    const moderated = setup({ posts: hidden, options: { moderate_users: '1', moderate_unapproved: '1' } });
    expect((await moderated.service.setStatus(moderated.req('7', { postid: 2 }, { action: 'reshow' }))).type).toBe('A_QUEUED');
    // a moderator's reshow is immediate
    const byMod = setup({ posts: hidden, options: { moderate_users: '1', moderate_unapproved: '1' } });
    expect((await byMod.service.setStatus(byMod.req('6', { postid: 2 }, { action: 'reshow' }))).type).toBe('A');
  });
  test('a moderator approves or rejects a queued comment', async () => {
    const queued = [Q(), A(2), C(4, 2, { type: 'C_QUEUED', queued: 1 })];
    const s = setup({ posts: queued });
    expect((await s.service.setStatus(s.req('6', { postid: 4 }, { action: 'approve' }))).type).toBe('C');
    expect(s.named('queuedcountUpdate', 'ccountUpdate')).toEqual([['queuedcountUpdate', -1], ['ccountUpdate', 1]]);
    const r = setup({ posts: queued });
    expect((await r.service.setStatus(r.req('6', { postid: 4 }, { action: 'reject' }))).type).toBe('C_HIDDEN');
    expect(r.named('queuedcountUpdate')).toEqual([['queuedcountUpdate', -1]]);
  });
  test('a moderator approves a queued question: counted, indexed and announced as the author', async () => {
    const s = setup({ posts: [Q({ type: 'Q_QUEUED', queued: 1 })] });
    expect((await s.service.setStatus(s.req('6', { postid: 1 }, { action: 'approve' }))).type).toBe('Q');
    expect(s.named('eventCreateForEntity')[0].slice(1, 3)).toEqual(['Q', '1']);
    expect(s.named('eventCreateForEntity')[1].slice(1, 3)).toEqual(['U', '5']);
  });
  test.each([
    ['an unknown action', '7', 2, { action: 'delete' }, 400, 'invalid_input'],
    ['hiding someone else\'s answer', '5', 2, { action: 'hide' }, 403, 'hide_not_allowed'],
    ['approving a post that is not queued', '6', 2, { action: 'approve' }, 403, 'approve_not_allowed'],
    ['reshowing a visible post', '7', 2, { action: 'reshow' }, 403, 'reshow_not_allowed'],
  ])('refused: %s', async (label, token, postid, body, status, code) => {
    const s = setup();
    await rejectsWith(s.service.setStatus(s.req(token, { postid }, body)), status, code);
    expect(s.names()).not.toContain('setType');
  });
});

describe('deleting', () => {
  test('a moderator deletes a hidden comment, updating its author\'s points', async () => {
    const s = setup({ posts: [Q(), A(2), C(4, 2, { type: 'C_HIDDEN', hidden: 1 })] });
    expect(await s.service.deletePost(s.req('6', { postid: 4 }))).toEqual({ id: '4', deleted: true });
    expect(s.named('deletePost')).toEqual([['deletePost', '4']]);
    expect(s.named('updatePoints')[0].slice(1, 3)).toEqual(['7', ['cposts']]);
  });
  test('a hidden selected answer: deleted, unselected, and its voters\' points updated', async () => {
    const s = setup({ posts: [Q({ selchildid: '2' }), A(2, { type: 'A_HIDDEN', hidden: 1 })], answers: { postUserVotes: [{ userid: '8', vote: 1 }, { userid: '9', vote: -1 }] } });
    await s.service.deletePost(s.req('6', { postid: 2 }));
    expect(s.named('setSelchildid')).toEqual([['setSelchildid', '1', null, null]]);
    expect(s.named('updatePoints').map(c => c.slice(1, 3))).toEqual([['5', ['aselects']], ['7', ['aposts', 'aselecteds', 'avoteds', 'upvoteds', 'downvoteds']], ['8', ['aupvotes']], ['9', ['adownvotes']]]);
  });
  test('a hidden question: deleted, the category counts recounted, the author\'s and voters\' points updated', async () => {
    const s = setup({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1 })], answers: { getCategoryPath: [3, 4], postUserVotes: [{ userid: '8', vote: -1 }] } });
    await s.service.deletePost(s.req('6', { postid: 1 }));
    expect(s.named('deletePost', 'pathQcountUpdate')).toEqual([['deletePost', '1'], ['pathQcountUpdate', [3, 4]]]);
    expect(s.named('updatePoints').map(c => c.slice(1, 3))).toEqual([['5', ['qposts', 'aselects', 'qvoteds', 'upvoteds', 'downvoteds']], ['8', ['qdownvotes']]]);
  });
  test('a question closed with a note cannot be deleted: the note is one of its children, as in PHP', async () => {
    const note = { ...base, postid: '30', type: 'NOTE', basetype: 'N', parentid: '1', userid: '5', content: 'n' };
    await rejectsWith(setup({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1, closedbyid: '30' }), note] }).service.deletePost(setup().req('6', { postid: 1 })), 403, 'delete_not_allowed');
  });
  test('not when visible, with answers or comments, as a duplicate target, or without the permission', async () => {
    await rejectsWith(setup().service.deletePost(setup().req('6', { postid: 4 })), 403, 'delete_not_allowed');
    await rejectsWith(setup({ posts: [Q(), A(2, { type: 'A_HIDDEN', hidden: 1 }), C(4, 2)] }).service.deletePost(setup().req('6', { postid: 2 })), 403, 'delete_not_allowed');
    await rejectsWith(setup({ posts: [Q({ type: 'Q_HIDDEN', hidden: 1 })], duplicates: [Q({ postid: '9', closedbyid: '1' })] }).service.deletePost(setup().req('6', { postid: 1 })), 403, 'delete_not_allowed');
    await rejectsWith(setup({ posts: [Q(), A(2, { type: 'A_HIDDEN', hidden: 1 })] }).service.deletePost(setup().req('7', { postid: 2 })), 403, 'delete_not_allowed');
  });
});

describe('claiming an anonymous post', () => {
  test('the visitor who wrote it, once signed in, takes it over with its points', async () => {
    const s = setup({ posts: [Q(), A(2, { userid: null, cookieid: '123' })] });
    expect(await s.service.claimPost({ token: '7', ip: 'ip', cookieid: '123', postid: 2 })).toEqual({ id: '2', userid: 7 });
    expect(s.named('setUserid', 'uservoteRemoveOwn', 'recountVotes', 'incrementLimits')).toEqual([['setUserid', '2', 7], ['uservoteRemoveOwn', '2'], ['recountVotes', '2'], ['incrementLimits', 7, 'ip', 'A', 2000]]);
    expect(s.named('updatePoints').map(c => c.slice(1, 3))).toEqual([[null, ['aposts', 'aselecteds', 'avoteds', 'upvoteds', 'downvoteds']], [7, ['aposts', 'aselecteds', 'avoteds', 'aupvotes', 'adownvotes', 'upvoteds', 'downvoteds']]]);
  });
  test('refused for another cookie, and over the posting limit', async () => {
    await rejectsWith(setup({ posts: [Q(), A(2, { userid: null, cookieid: '123' })] }).service.claimPost({ token: '7', cookieid: '999', postid: 2 }), 403, 'claim_not_allowed');
    await rejectsWith(setup({ posts: [Q(), C(4, 1, { userid: null, cookieid: '123' })], answers: { findLimits: { user: { period: 2000, count: 10 } } } }).service.claimPost({ token: '7', cookieid: '123', postid: 4 }), 429, 'comment_limit');
    await rejectsWith(setup({ posts: [Q({ userid: null, cookieid: '123' })], answers: { findLimits: { ip: { period: 2000, count: 10 } } } }).service.claimPost({ token: '7', cookieid: '123', postid: 1 }), 429, 'ask_limit');
  });
});

describe('flags', () => {
  test('flagging: the flag, the counts, the limit and the write', async () => {
    const s = setup();
    expect(await s.service.flagPost(s.req('5', { postid: 2 }))).toEqual({ id: '2', flagcount: 1, type: 'A' });
    expect(s.named('userflagSet', 'recountFlags', 'flaggedcountUpdate', 'incrementLimits', 'userWritten')).toEqual([
      ['userflagSet', '2', 5, true], ['recountFlags', '2', 1], ['flaggedcountUpdate', 1], ['incrementLimits', 5, '1.2.3.4', 'F', 2000], ['userWritten', 5, '1.2.3.4'],
    ]);
  });
  test('enough flags hide the post as a system action', async () => {
    const s = setup({ posts: [Q(), A(2, { flagcount: '2' })] });
    expect(await s.service.flagPost(s.req('5', { postid: 2 }))).toEqual({ id: '2', flagcount: 3, type: 'A_HIDDEN' });
    expect(s.named('setType')).toEqual([['setType', '2', 'A_HIDDEN', { updatetype: 'H', userid: null, ip: '1.2.3.4' }]]);
  });
  test.each([
    ['your own post', '7', 2, {}, 403, 'flag_not_allowed'],
    ['a post you already flagged', '5', 2, { userflag: 1 }, 403, 'flag_not_allowed'],
    ['when signed out', 'none', 2, {}, 403, 'flag_not_allowed'],
    ['over the flag limit', '5', 2, { answers: { findLimits: { user: { period: 2000, count: 10 } } } }, 429, 'flag_limit'],
    ['when flagging is off', '5', 2, { options: { flagging_of_posts: '' } }, 403, 'flag_not_allowed'],
  ])('refused: %s', async (label, token, postid, args, status, code) => {
    const s = setup(args);
    await rejectsWith(s.service.flagPost(s.req(token, { postid })), status, code);
    expect(s.names()).not.toContain('userflagSet');
  });
  test('unflagging and clearing', async () => {
    const s = setup({ posts: [Q(), A(2, { flagcount: '2' })], userflag: 1 });
    expect(await s.service.unflagPost(s.req('5', { postid: 2 }))).toEqual({ id: '2', flagcount: 1 });
    expect(s.named('userflagSet', 'recountFlags', 'flaggedcountUpdate')).toEqual([['userflagSet', '2', 5, false], ['recountFlags', '2', -1], ['flaggedcountUpdate', -1]]);
    await rejectsWith(setup().service.unflagPost(setup().req('5', { postid: 2 })), 403, 'unflag_not_allowed');
    const c = setup({ posts: [Q(), A(2, { flagcount: '2' })] });
    expect(await c.service.clearFlags(c.req('6', { postid: 2 }))).toEqual({ id: '2', flagcount: 0 });
    expect(c.named('userflagsClearAll', 'flaggedcountUpdate', 'resetFlags')).toEqual([['userflagsClearAll', '2'], ['flaggedcountUpdate', -2], ['resetFlags', '2']]);
    await rejectsWith(setup({ posts: [Q(), A(2, { flagcount: '2' })] }).service.clearFlags(setup().req('5', { postid: 2 })), 403, 'clearflags_not_allowed');
  });
});

describe('editing', () => {
  const EDIT = { min_len_q_title: '5', max_len_q_title: '120', min_len_q_content: '0', min_num_q_tags: '0', max_num_q_tags: '5', min_len_a_content: '3', min_len_c_content: '3', permit_edit_silent: '40' };
  const edit = (args, token, postid, body) => { const s = setup({ ...args, options: { ...EDIT, ...(args.options ?? {}) } }); return { s, run: s.service.editPost(s.req(token, { postid }, body)) }; };
  test('the asker edits the title, content and tags: the post rewritten and reindexed', async () => {
    const { s, run } = edit({}, '5', 1, { title: ' A better title ', content: '<p>New</p>', format: 'html', tags: ['x', 'y'] });
    expect(await run).toEqual({ id: '1', type: 'Q' });
    const [call] = s.named('setContent');
    expect(call[1]).toBe('1');
    expect(JSON.stringify(call)).toContain('A better title');
    expect(JSON.stringify(call)).toContain('<p>New</p>');
  });
  test('fields left out keep their values', async () => {
    const { s, run } = edit({}, '5', 1, { tags: 'z' });
    await run;
    expect(JSON.stringify(s.named('setContent'))).toContain('Question title');
  });
  test.each([
    ['someone without edit rights', '7', 1, { title: 'Changed title' }, 403, 'edit_not_allowed'],
    ['a title that is too short', '5', 1, { title: 'Hi' }, 400, 'validation_failed'],
    ['tags that are not text', '5', 1, { tags: 5 }, 400, 'invalid_input'],
    ['a notify flag that is not a boolean', '5', 1, { notify: 'yes' }, 400, 'invalid_input'],
    ['a post that does not exist', '5', 50, {}, 404, 'post_not_found'],
    ['no post ID', '5', null, {}, 404, 'post_not_found'],
  ])('refused: %s', async (label, token, postid, body, status, code) => {
    const { s, run } = edit({}, token, postid, body);
    await rejectsWith(run, status, code);
    expect(s.names()).not.toContain('setContent');
  });
  test('an answer edited by its author; too short is refused', async () => {
    const { run } = edit({}, '7', 2, { content: 'A clearer answer' });
    expect(await run).toEqual({ id: '2', type: 'A' });
    await rejectsWith(edit({}, '7', 2, { content: 'x' }).run, 400, 'validation_failed');
    await rejectsWith(edit({}, '5', 2, { content: 'Not mine to edit' }).run, 403, 'edit_not_allowed');
  });
  test('an answer converted to a comment on the question, within the comment limit', async () => {
    const { run } = edit({}, '7', 2, { convertToCommentOn: 1 });
    expect(await run).toEqual({ id: '2', type: 'C' });
    await rejectsWith(edit({}, '7', 2, { convertToCommentOn: '1' }).run, 400, 'invalid_input');
    await rejectsWith(edit({ answers: { findLimits: { user: { period: 2000, count: 10 } } } }, '7', 2, { convertToCommentOn: 1 }).run, 429, 'comment_limit');
    // onto another answer, or (not offered) onto itself, which keeps it an answer
    expect(await edit({}, '7', 2, { convertToCommentOn: 3 }).run).toEqual({ id: '2', type: 'C' });
    expect(await edit({}, '7', 2, { convertToCommentOn: 2 }).run).toEqual({ id: '2', type: 'A' });
  });
  test('a comment edited by its author', async () => {
    expect(await edit({}, '7', 4, { content: 'A better comment' }).run).toEqual({ id: '4', type: 'C' });
    await rejectsWith(edit({}, '7', 4, { content: 'no' }).run, 400, 'validation_failed');
  });
  test('a moderated author\'s edit goes back to the queue when "moderate edited again" is on', async () => {
    const { run } = edit({ options: { moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' } }, '7', 2, { content: 'Edited answer' });
    expect(await run).toEqual({ id: '2', type: 'A_QUEUED' });
  });
});
