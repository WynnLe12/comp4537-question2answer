// The admin recalculation tools (services/recalc.js), one step at a time against a fake database:
// the state each step moves to ("operation\tlength\tnext\tdone", as PHP's) and the batch it writes.
const { createRecalcService, OPERATIONS } = require('../../src/services/recalc');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const OPTIONS = { cache_qcount: '3', cache_acount: '4', cache_ccount: '5', cache_userpointscount: '12', max_store_user_updates: '50' };
// rows() answers by the table the query reads; next is the first ID of the batch.
function setup({ tables = {}, counts = {}, level = 100, answers = {} } = {}) {
  const fake = fakeRepository({
    findActor: id => (id === 1 ? { userid: 1, level } : null), loadOptions: optionsWith(OPTIONS),
    rows: (sql, [next, limit] = []) => {
      const table = Object.keys(tables).find(name => sql.includes(name));
      const ids = (tables[table] ?? []).filter(id => id >= next);
      return ids.slice(0, typeof limit === 'number' ? limit : /LIMIT (\d+)/.exec(sql)?.[1] ?? 1000).map(id => ({ pageid: id, wordid: id, postid: id, userid: id, categoryid: id }));
    },
    countOf: sql => counts[Object.keys(counts).find(name => sql.includes(name))] ?? 0,
    postsForReindexing: [], postsForDeleting: [], questionFamily: [], wordMapToIds: new Map(), categoryPath: [], wordMapToIdsAdd: new Map(),
    ...answers,
  });
  const deleted = [];
  const service = createRecalcService(fake.repository, { identify: async token => (token === 'ok' ? { id: 1 } : null), postChangeService: { deletePost: async r => deleted.push(r) } });
  return { ...fake, deleted, service, step: (state, token = 'ok') => service.perform({ token, ip: 'ip', body: { state, seconds: 0 } }) };
}
const st = (operation, length = 0, next = 0, done = 0) => `${operation}\t${length}\t${next}\t${done}`;

test('state parsing: missing parts are 0, numbers read as PHP reads them', () => {
  const { service } = setup();
  expect(service.parse('dorecountposts')).toEqual({ operation: 'dorecountposts', length: 0, next: 0, done: 0 });
  expect(service.parse(st('x', '12abc', ' 3', '4.9'))).toEqual({ operation: 'x', length: 12, next: 3, done: 4 });
  expect(service.parse(undefined)).toEqual({ operation: '', length: 0, next: 0, done: 0 });
  expect(OPERATIONS).toEqual(['dorecountposts', 'doreindexcontent', 'dorecalcpoints', 'dorefillevents', 'dorecalccategories', 'dodeletehidden', 'doblobstodisk', 'doblobstodb']);
});

describe('starting each tool moves to its first stage with that stage\'s length', () => {
  test.each([
    ['dorecountposts', st('dorecountposts_postcount')],
    ['doreindexcontent', st('doreindexcontent_pagereindex', 7)],
    ['dorecalcpoints', st('dorecalcpoints_usercount')],
    ['dorefillevents', st('dorefillevents_qcount')],
    ['dorecalccategories', st('dorecalccategories_postcount')],
    ['dodeletehidden', st('dodeletehidden_comments', 2)],
    ['doblobstodisk', st('doblobstodisk_complete')],
    ['doblobstodb', st('doblobstodb_complete')],
  ])('%s', async (operation, expected) => {
    const s = setup({ counts: { qa_pages: 7 }, answers: { postsForDeleting: [11, 12] } });
    expect(await s.step(operation)).toEqual({ state: expected });
  });
});

describe('stages', () => {
  test('recounting posts: the counts, then votes and answers in batches with hotness, then unupaqcount', async () => {
    const s = setup({ tables: { qa_posts: [1, 2, 3] }, counts: { qa_posts: 3 } });
    expect(await s.step(st('dorecountposts_postcount'))).toEqual({ state: st('dorecountposts_votecount', 3) });
    expect(s.names().filter(n => n.endsWith('countUpdate'))).toEqual(['qcountUpdate', 'acountUpdate', 'ccountUpdate', 'unaqcountUpdate', 'unselqcountUpdate']);
    const votes = setup({ tables: { qa_posts: [1, 2, 3] } });
    expect(await votes.step(st('dorecountposts_votecount', 3, 0, 0))).toEqual({ state: st('dorecountposts_votecount', 3, 4, 3) });
    expect(votes.named('postsVotesRecount', 'hotnessUpdateRange').map(c => c.slice(0, 3))).toEqual([['postsVotesRecount', 0, 3], ['hotnessUpdateRange', 0, 3]]);
    const answers = setup({ tables: { qa_posts: [5] } });
    await answers.step(st('dorecountposts_acount', 1, 5, 0));
    expect(answers.named('postsAnswersRecount')).toEqual([['postsAnswersRecount', 5, 5]]);
    expect(await setup({ counts: { qa_posts: 9 } }).step(st('dorecountposts_votecount', 3, 4, 3))).toEqual({ state: st('dorecountposts_acount', 9) });
    const end = setup();
    expect(await end.step(st('dorecountposts_acount', 3, 4, 3))).toEqual({ state: st('dorecountposts_complete') });
    expect(end.names()).toContain('unupaqcountUpdate');
  });
  test('reindexing: pages are only counted, posts reindexed without counts, then words recounted and tags', async () => {
    const pages = setup({ tables: { qa_pages: [2, 5] } });
    expect(await pages.step(st('doreindexcontent_pagereindex', 2))).toEqual({ state: st('doreindexcontent_pagereindex', 2, 6, 2) });
    expect(await setup().step(st('doreindexcontent_pagereindex', 2, 6, 2))).toEqual({ state: st('doreindexcontent_postcount') });
    const count = setup();
    expect(await count.step(st('doreindexcontent_postcount'))).toEqual({ state: st('doreindexcontent_postreindex', 12) });
    const posts = setup({ answers: { postsForReindexing: [{ postid: 8, type: 'Q', questionid: 8, title: 'T', content: 'c', format: '', tags: 'a' }, { postid: 9, type: 'A', questionid: 8, content: 'd' }] } });
    expect(await posts.step(st('doreindexcontent_postreindex', 12, 8, 0))).toEqual({ state: st('doreindexcontent_postreindex', 12, 10, 2) });
    expect(posts.named('prepareForReindexing')).toEqual([['prepareForReindexing', 8, 9]]);
    expect(posts.named('deleteIndexed')).toHaveLength(8);
    expect(posts.names()).not.toContain('updateWordCounts');
    const done = setup({ counts: { qa_words: 40 } });
    expect(await done.step(st('doreindexcontent_postreindex', 12, 10, 2))).toEqual({ state: st('doreindexposts_wordcount', 40) });
    expect(done.named('truncateIndexes')).toEqual([['truncateIndexes', 10]]);
    const words = setup({ tables: { qa_words: [1, 2] } });
    expect(await words.step(st('doreindexposts_wordcount', 2))).toEqual({ state: st('doreindexposts_wordcount', 2, 3, 2) });
    expect(words.named('wordsRecount')).toEqual([['wordsRecount', 0, 2]]);
    const last = setup();
    expect(await last.step(st('doreindexposts_wordcount', 2, 3, 2))).toEqual({ state: st('doreindexposts_complete') });
    expect(last.names()).toContain('tagcountUpdate');
  });
  test('points: user counts, then ten users at a time, then removing points of users that are gone', async () => {
    const counts = setup();
    expect(await counts.step(st('dorecalcpoints_usercount'))).toEqual({ state: st('dorecalcpoints_recalc', 12) });
    expect(counts.names().filter(n => n.endsWith('countUpdate'))).toEqual(['userpointscountUpdate', 'uapprovecountUpdate']);
    const users = Array.from({ length: 12 }, (x, i) => i + 1);
    const batch = setup({ tables: { qa_users: users } });
    expect(await batch.step(st('dorecalcpoints_recalc', 12, 1, 0))).toEqual({ state: st('dorecalcpoints_recalc', 12, 11, 10) });
    expect(batch.named('usersRecalcPoints').map(c => c.slice(1, 3))).toEqual([[1, 10]]);
    const lastBatch = setup({ tables: { qa_users: users } });
    expect(await lastBatch.step(st('dorecalcpoints_recalc', 12, 11, 10))).toEqual({ state: st('dorecalcpoints_complete') });
    expect(lastBatch.named('execute')).toEqual([['execute', 'DELETE FROM qa_userpoints WHERE userid>?', [12]]]);
    const none = setup();
    await none.step(st('dorecalcpoints_recalc', 0, 1, 0));
    expect(none.named('execute')).toEqual([['execute', 'DELETE FROM qa_userpoints WHERE userid>?', [1]]]);
    expect(none.names()).not.toContain('usersRecalcPoints');
  });
  test('refilling events: the question count, then each question\'s events at their original times', async () => {
    const q = setup({ counts: { Q_HIDDEN: 2 } });
    expect(await q.step(st('dorefillevents_qcount'))).toEqual({ state: st('dorefillevents_refill', 5) });
    const family = [
      { postid: 1, basetype: 'Q', parentid: null, userid: '5', createdts: 100, updatedts: 150, updatetype: 'E', lastuserid: '6', tags: 'a,b', categoryid: 3 },
      { postid: 2, basetype: 'A', parentid: 1, userid: '7', createdts: 110, updatedts: null },
      { postid: 3, basetype: 'C', parentid: 2, userid: '8', createdts: 120, updatedts: null },
      { postid: 4, basetype: 'C', parentid: 2, userid: '9', createdts: 130, updatedts: null },
      { postid: 5, basetype: 'C', parentid: 1, userid: null, createdts: 125, updatedts: null },
      { postid: 6, basetype: 'Q', parentid: 2, userid: '9', createdts: 140, updatedts: 160, updatetype: 'E', lastuserid: '9' },
    ];
    const s = setup({ tables: { "LEFT(type, 1)='Q'": [1] }, answers: { questionFamily: family, wordMapToIds: new Map([['a', 50], ['b', 51]]), categoryPath: [{ categoryid: 3 }] } });
    expect(await s.step(st('dorefillevents_refill', 5, 1, 0))).toEqual({ state: st('dorefillevents_refill', 5, 2, 1) });
    const events = s.calls.filter(([n]) => n.startsWith('event')).map(c => c.join(' '));
    expect(events).toEqual([
      'eventCreateForEntity Q 1 1 1  5 100', 'eventCreateForEntity U 5 1 1  5 100',
      'eventCreateForEntity Q 1 1 1 E 6 150', 'eventCreateForEntity U 6 1 1 E 6 150', 'eventCreateNotEntity 5 1 1 E 6 150',
      'eventCreateForEntity Q 1 1 2  7 110', 'eventCreateForEntity U 7 1 2  7 110', 'eventCreateNotEntity 5 1 2  7 110',
      'eventCreateForEntity Q 1 1 3 N 8 120', 'eventCreateForEntity U 8 1 3 N 8 120', 'eventCreateNotEntity 7 1 3 N 8 120',
      'eventCreateForEntity Q 1 1 4 N 9 130', 'eventCreateForEntity U 9 1 4 N 9 130', 'eventCreateNotEntity 7 1 4 N 9 130',
      'eventCreateForEntity Q 1 1 5 U  125', 'eventCreateNotEntity 5 1 5 U  125',
      'eventCreateForEntity Q 1 1 6 Y 9 140', 'eventCreateForEntity U 9 1 6 Y 9 140', 'eventCreateNotEntity 7 1 6 Y 9 140',
      'eventCreateForEntity T 50 1 1  5 100', 'eventCreateForEntity T 51 1 1  5 100', 'eventCreateForEntity C 3 1 1  5 100',
      'eventCreateNotEntity 8 1 4 Y 9 130',
    ]);
    expect(await setup().step(st('dorefillevents_refill', 5, 2, 1))).toEqual({ state: st('dorefillevents_complete') });
  });
  test('categories: post counts, category IDs and paths in batches, then counts and back paths per category', async () => {
    const c = setup({ counts: { qa_posts: 6 } });
    expect(await c.step(st('dorecalccategories_postcount'))).toEqual({ state: st('dorecalccategories_postupdate', 6) });
    const posts = setup({ tables: { qa_posts: [1, 2] } });
    expect(await posts.step(st('dorecalccategories_postupdate', 6))).toEqual({ state: st('dorecalccategories_postupdate', 6, 3, 2) });
    expect(posts.named('postsRecalcCategoryid', 'postsCalcCategoryPathRange')).toEqual([['postsRecalcCategoryid', 0, 2], ['postsCalcCategoryPathRange', 0, 2]]);
    expect(await setup({ counts: { qa_categories: 4 } }).step(st('dorecalccategories_postupdate', 6, 3, 2))).toEqual({ state: st('dorecalccategories_recount', 4) });
    const recount = setup({ tables: { qa_categories: [3, 4] } });
    expect(await recount.step(st('dorecalccategories_recount', 4))).toEqual({ state: st('dorecalccategories_recount', 4, 5, 2) });
    expect(recount.named('pathQcountUpdate')).toEqual([['pathQcountUpdate', { categoryid: 3 }], ['pathQcountUpdate', { categoryid: 4 }]]);
    expect(await setup({ counts: { qa_categories: 4 } }).step(st('dorecalccategories_recount', 4, 5, 2))).toEqual({ state: st('dorecalccategories_backpaths', 4) });
    const back = setup({ tables: { qa_categories: [3, 4] } });
    await back.step(st('dorecalccategories_backpaths', 4));
    expect(back.named('categoriesRecalcBackpaths')).toEqual([['categoriesRecalcBackpaths', 0, 4]]);
    expect(await setup().step(st('dorecalccategories_backpaths', 4, 5, 2))).toEqual({ state: st('dorecalccategories_complete') });
  });
  test('deleting hidden posts: comments, answers, then questions, one at a time, each deleted after the step commits', async () => {
    const s = setup({ answers: { postsForDeleting: (type, next) => (type === 'C' && next <= 7 ? [7] : []) } });
    expect(await s.step(st('dodeletehidden_comments', 1))).toEqual({ state: st('dodeletehidden_comments', 1, 8, 1) });
    expect(s.afterCommit).toHaveLength(1);
    await s.afterCommit[0]();
    expect(s.deleted).toEqual([{ token: 'ok', ip: 'ip', postid: 7 }]);
    expect(await s.step(st('dodeletehidden_comments', 1, 8, 1))).toEqual({ state: st('dodeletehidden_answers', 0) });
    expect(await setup().step(st('dodeletehidden_answers'))).toEqual({ state: st('dodeletehidden_questions', 0) });
    expect(await setup().step(st('dodeletehidden_questions'))).toEqual({ state: st('dodeletehidden_complete') });
  });
  test('an unknown stage ends the run', async () => {
    expect(await setup().step(st('dorecountposts_unknown'))).toEqual({ state: '' });
  });
});

describe('running', () => {
  test('steps repeat until the stage is done or the time runs out', async () => {
    const s = setup({ tables: { qa_pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } });
    const { state } = await s.service.perform({ token: 'ok', body: { state: st('doreindexcontent_pagereindex', 12), seconds: 5 } });
    expect(state).toBe(st('doreindexcontent_pagereindex', 12, 13, 12)); // two batches of ten, then done reaches the length
    expect(s.named('setMaxStoreUserUpdates')).toEqual([['setMaxStoreUserUpdates', '50'], ['setMaxStoreUserUpdates', '50']]);
  });
  test('with no time given, one step only; at most ten seconds', async () => {
    const s = setup({ tables: { qa_pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } });
    expect((await s.service.perform({ token: 'ok', body: { state: st('doreindexcontent_pagereindex', 12) } })).state).toBe(st('doreindexcontent_pagereindex', 12, 11, 10));
    expect((await s.service.perform({ token: 'ok', body: { state: st('doreindexcontent_pagereindex', 12), seconds: -5 } })).state).toBe(st('doreindexcontent_pagereindex', 12, 11, 10));
  });
  test('only admins, and only real tool states', async () => {
    await rejectsWith(setup().step('dorecountposts', 'none'), 401, 'unauthenticated');
    await rejectsWith(setup({ level: 80 }).step('dorecountposts'), 403, 'no_privileges');
    for (const state of ['', 'dropeverything', 'DOrecount_x', 'dorecountposts_', '1_2']) await rejectsWith(setup().step(state), 400, 'invalid_input', { state: 'invalid' });
  });
});
