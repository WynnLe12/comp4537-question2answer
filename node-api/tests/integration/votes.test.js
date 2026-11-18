const request = require('supertest');
const { createApp } = require('../../src/app');
const { createVoteService } = require('../../src/services/votes');
const { blockIpMatch, isIpBlocked, limitsRemaining, permitError, userLevelForPost, PERMIT } = require('../../src/q2a/permissions');
const { pointsUpdateStatement } = require('../../src/q2a/points');
const { loadOptions } = require('../../src/q2a/options');

// Uses the real option loader (stored values, then Q2A defaults) over a fake qa_options table.
let options;
beforeAll(async () => {
  const load = async (values, dbTime) => loadOptions({
    query: async sql => (sql.includes('UNIX_TIMESTAMP') ? [[{ now: dbTime }]] : [Object.entries(values).map(([title, content]) => ({ title, content }))]),
  });
  const cache = new Map();
  options = (values = {}, dbTime = 7200 * 1000) => {
    const key = JSON.stringify([values, dbTime]);
    if (!cache.has(key)) throw new Error(`options ${key} not preloaded`);
    return cache.get(key);
  };
  for (const [values, dbTime] of [
    [{}, 7200 * 1000],
    [{ block_ips_write: '1.2.3.4, 10.0.0.1 - 10.0.0.9' }, 7200 * 1000], [{ block_ips_write: '' }, 7200 * 1000],
    [{ max_rate_user_votes: 10, max_rate_ip_votes: 20 }, 3600 * 5],
    [{ permit_vote_down: PERMIT.POINTS, permit_vote_down_points: 150 }, 7200 * 1000],
  ]) cache.set(JSON.stringify([values, dbTime]), await load(values, dbTime));
});

describe('vote API contract (repository replaced in these tests)', () => {
  let app, store, calls;
  const user = { userid: 7, level: 0, flags: 0, points: 100, categoryLevels: new Map() };
  beforeEach(() => {
    calls = [];
    store = {
      post: { postid: 5, type: 'Q', basetype: 'Q', hidden: 0, queued: 0, userid: 9, parentid: null, netvotes: 0, categoryids: '' },
      vote: undefined,
      limits: {},
    };
    const q = new Proxy({
      loadOptions: async () => options({}, 7200 * 1000),
      findPost: async id => (id === 5 ? store.post : undefined),
      findVoter: async id => (id === 7 ? user : null),
      findLimits: async () => store.limits,
      getUserVote: async () => store.vote,
      postVotes: async () => ({ upvotes: 1, downvotes: 0, netvotes: 1 }),
    }, { get: (target, name) => target[name] ?? (async (...args) => { calls.push(name); }) });
    const repository = { transaction: work => work(q) };
    const identify = async token => (token === 'valid' ? { id: 7 } : null);
    app = createApp({ service: {}, voteService: createVoteService(repository, { identify }) });
  });
  const put = (path, body, token = 'valid') => request(app).put(path)
    .set('Cookie', `q2a_node_session=${token}`).set('X-Q2A-Request', '1').send(body);

  test('records a vote and runs the same write steps as qa_vote_set()', async () => {
    const response = await put('/api/v1/posts/5/vote', { vote: 1 }).expect(200);
    expect(response.body).toEqual({ vote: 1, post: { id: 5, upvotes: 1, downvotes: 0, netvotes: 1 } });
    expect(calls).toEqual(['setUserVote', 'recountVotes', 'updatePoints', 'updatePoints', 'updateHotness', 'incrementLimits', 'userWritten']);
  });
  test('an unchanged vote writes nothing', async () => {
    store.vote = { vote: 1, flag: 0 };
    await put('/api/v1/posts/5/vote', { vote: 1 }).expect(200);
    expect(calls).toEqual([]);
  });
  test('requires the API request header and JSON', async () => {
    await request(app).put('/api/v1/posts/5/vote').send({ vote: 1 }).expect(403);
    await request(app).put('/api/v1/posts/5/vote').set('X-Q2A-Request', '1').type('form').send('vote=1').expect(403);
  });
  test.each([[{ vote: 2 }], [{ vote: '1' }], [{}], [{ vote: 0.5 }]])('rejects invalid body %j', async body => {
    expect((await put('/api/v1/posts/5/vote', body).expect(400)).body.error.code).toBe('invalid_input');
  });
  test.each([
    ['unknown post', '/api/v1/posts/6/vote', {}, 404, 'post_not_found'],
    ['non-numeric id', '/api/v1/posts/abc/vote', {}, 404, 'post_not_found'],
    ['hidden post', '/api/v1/posts/5/vote', { hidden: 1 }, 403, 'vote_disabled_hidden'],
    ['queued post', '/api/v1/posts/5/vote', { queued: 1 }, 403, 'vote_disabled_queued'],
    ['own post', '/api/v1/posts/5/vote', { userid: 7 }, 403, 'vote_not_allowed'],
    ['comment while comment voting is off', '/api/v1/posts/5/vote', { type: 'C', basetype: 'C' }, 403, 'vote_not_allowed'],
  ])('rejects %s', async (name, path, change, status, code) => {
    Object.assign(store.post, change);
    expect((await put(path, { vote: 1 }).expect(status)).body.error.code).toBe(code);
    expect(calls).toEqual([]);
  });
  test('hidden posts are reported before asking anonymous users to log in, as in PHP', async () => {
    store.post.hidden = 1;
    expect((await put('/api/v1/posts/5/vote', { vote: 1 }, 'none').expect(403)).body.error.code).toBe('vote_disabled_hidden');
    store.post.hidden = 0;
    expect((await put('/api/v1/posts/5/vote', { vote: 1 }, 'none').expect(401)).body.error.code).toBe('unauthenticated');
  });
  test('rate limits use the current hour by database time', async () => {
    store.limits = { user: { period: 2000, count: 300 } };
    expect((await put('/api/v1/posts/5/vote', { vote: 1 }).expect(429)).body.error.code).toBe('vote_limit');
    store.limits = { user: { period: 1999, count: 300 } };
    await put('/api/v1/posts/5/vote', { vote: 1 }).expect(200);
  });
});

describe('ported Q2A permission helpers', () => {
  test.each([
    ['10.0.0.5', '10.0.0.5', true], ['10.0.0.5', '10.0.0.6', false], ['10.0.0.5', '10.0.*.*', true],
    ['10.0.0.5', '10.0.0.1-10.0.0.9', true], ['10.0.1.5', '10.0.0.1-10.0.0.9', false],
    ['2001:db8::1', '2001:db8:0:0:0:0:0:1', true], ['2001:db8::1', '2001:db8:*:*:*:*:*:*', true], ['2001:db8::1', '2001:db9::1', false],
  ])('blockIpMatch(%s, %s) is %s', (ip, clause, expected) => expect(blockIpMatch(ip, clause)).toBe(expected));
  test('block_ips_write is split like qa_block_ips_explode()', () => {
    expect(isIpBlocked('10.0.0.5', options({ block_ips_write: '1.2.3.4, 10.0.0.1 - 10.0.0.9' }))).toBe(true);
    expect(isIpBlocked('10.0.0.5', options({ block_ips_write: '' }))).toBe(false);
  });
  test('limits take the smaller of the user and IP allowance in the current period', () => {
    const o = options({ max_rate_user_votes: 10, max_rate_ip_votes: 20 }, 3600 * 5);
    expect(limitsRemaining('V', { period: 5, count: 4 }, { period: 5, count: 15 }, o)).toBe(5);
    expect(limitsRemaining('V', { period: 4, count: 9 }, undefined, o)).toBe(10);
  });
  test('points-based permits become user permits once the threshold is met', () => {
    const o = options({ permit_vote_down: PERMIT.POINTS, permit_vote_down_points: 150 });
    expect(permitError('permit_vote_down', { userid: 1, level: 0, flags: 0, points: 149 }, 0, o)).toBe('level');
    expect(permitError('permit_vote_down', { userid: 1, level: 0, flags: 0, points: 150 }, 0, o)).toBe(false);
  });
  test('category levels raise the user level for posts in that category', () => {
    const user = { level: 0, categoryLevels: new Map([[3, 100]]) };
    expect(userLevelForPost({ categoryids: '1,3' }, user)).toBe(100);
    expect(userLevelForPost({ categoryids: '' }, user)).toBeNull();
  });
  test('points SQL constrains every subquery to the user and keeps the bonus', () => {
    const { sql, params } = pointsUpdateStatement(42, ['qupvotes'], options());
    expect(sql).toMatch(/^INSERT INTO qa_userpoints \(userid, qupvotes, points\) VALUES \(\?, @_qupvotes:=\(SELECT COUNT\(\*\) AS qupvotes /);
    expect(sql).toMatch(/points=100\+.*\+\(10\*@_qupvotes\).*\+bonus$/);
    expect(params).toEqual([42, 42]);
    expect(pointsUpdateStatement(null, ['qupvotes'], options())).toBeNull();
  });
});
