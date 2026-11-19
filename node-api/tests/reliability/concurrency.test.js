// Concurrency: many users act on the same posts at the same moment through Node. PHP runs Q2A's statements
// without transactions, so this is not a comparison with PHP; it checks that Node, which runs each change
// in a transaction, never fails a request under contention (no deadlock or lock errors surfacing as 503)
// and that every cached count still agrees with the rows afterwards (the invariants in db-state.js).
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { apiDriver } = require('../parity/post-helpers');
const { checkInvariants, withoutUpstreamDrift, setOptions } = require('./db-state');

const run = process.env.RELIABILITY === '1' ? describe : describe.skip;
jest.setTimeout(10 * 60 * 1000);
const USERS = 12;

run('Concurrency: simultaneous changes to the same posts through Node', () => {
  const suffix = randomBytes(3).toString('hex');
  let pool, owner, others, q, a, baseline, restoreOptions;

  // Invariant violations now that were not there before the suite (others' history is not this suite's).
  async function newViolations() {
    const now = withoutUpstreamDrift(await checkInvariants(pool));
    const extra = {};
    // Site counts are compared by how far they are off, since the totals themselves grow with the suite.
    const key = (name, r) => (name === 'site counts' ? `${r.title}:${Number(r.content) - Number(r.actual)}` : JSON.stringify(r));
    for (const [name, rows] of Object.entries(now)) {
      const before = new Set((baseline[name] ?? []).map(r => key(name, r)));
      const added = rows.filter(r => !before.has(key(name, r)));
      if (added.length) extra[name] = added;
    }
    return extra;
  }
  // Runs requests together; none may fail with a server error.
  async function together(label, requests) {
    const responses = await Promise.all(requests.map(make => make()));
    const failed = responses.filter(r => r.status >= 500);
    if (failed.length) throw new Error(`${label}: ${failed.length} of ${responses.length} requests failed: ${JSON.stringify(failed.slice(0, 3).map(r => [r.status, r.body]))}`);
    return responses;
  }
  const post = async id => (await pool.query('SELECT * FROM qa_posts WHERE postid=?', [id]))[0][0];

  beforeAll(async () => {
    pool = createPool();
    restoreOptions = await setOptions([pool], Object.fromEntries(['max_rate_user_votes', 'max_rate_ip_votes', 'max_rate_user_flags', 'max_rate_ip_flags', 'max_rate_user_as', 'max_rate_ip_as', 'max_rate_user_cs', 'max_rate_ip_cs', 'max_rate_ip_qs', 'max_rate_user_qs'].map(name => [name, '100000'])));
    baseline = withoutUpstreamDrift(await checkInvariants(pool));
    owner = apiDriver(pool);
    await owner.register(`cc0${suffix}`);
    others = [];
    for (let i = 1; i < USERS; i++) {
      const driver = apiDriver(pool);
      await driver.register(`cc${i}${suffix}`);
      others.push(driver);
    }
    const asked = await owner.ask({ title: `Concurrent ${suffix} question about locking`, content: 'Many people will act on this at the same moment.', tags: `cc${suffix} locking` });
    q = asked.id;
    a = (await others[0].answer(q, { content: `An answer for ${suffix} that everyone votes on.` })).id;
  });
  afterAll(async () => { if (restoreOptions) await restoreOptions(); await pool.end(); });

  test('simultaneous up votes are all counted', async () => {
    await together('votes', others.map(d => () => d._client.put(`/api/v1/posts/${q}/vote`).set('X-Q2A-Request', '1').send({ vote: 1 })));
    expect(Number((await post(q)).upvotes)).toBe(USERS - 1);
    expect(await newViolations()).toEqual({});
  });

  test('simultaneous vote changes on a question and an answer stay consistent', async () => {
    await together('vote changes', [
      ...others.map(d => () => d._client.put(`/api/v1/posts/${q}/vote`).set('X-Q2A-Request', '1').send({ vote: -1 })),
      ...others.slice(1).map(d => () => d._client.put(`/api/v1/posts/${a}/vote`).set('X-Q2A-Request', '1').send({ vote: 1 })),
    ]);
    const [question, answer] = [await post(q), await post(a)];
    expect([Number(question.upvotes), Number(question.downvotes), Number(question.netvotes)]).toEqual([0, USERS - 1, -(USERS - 1)]);
    expect(Number(answer.netvotes)).toBe(USERS - 2);
    expect(Number(question.amaxvote)).toBe(USERS - 2);
    expect(await newViolations()).toEqual({});
  });

  test('simultaneous answers all land and keep the counts right', async () => {
    const responses = await together('answers', others.slice(0, 8).map((d, i) => () => d._client.post(`/api/v1/questions/${q}/answers`).set('X-Q2A-Request', '1').send({ content: `Parallel answer ${i} for ${suffix} with enough words.`, format: '', notify: false, email: '', name: '' })));
    expect(responses.filter(r => r.status === 201)).toHaveLength(8);
    expect(Number((await post(q)).acount)).toBe(9);
    expect(await newViolations()).toEqual({});
  });

  test('simultaneous flags hide the answer exactly once', async () => {
    await together('flags', others.slice(1).map(d => () => d._client.put(`/api/v1/posts/${a}/flag`).set('X-Q2A-Request', '1').send({})));
    const answer = await post(a);
    const [[{ flags }]] = await pool.query('SELECT SUM(flag) AS flags FROM qa_uservotes WHERE postid=?', [a]);
    expect(Number(answer.flagcount)).toBe(Number(flags));
    expect(await newViolations()).toEqual({});
  });

  test('simultaneous favorites are each stored once', async () => {
    await together('favorites', [...others, ...others].map(d => () => d._client.put(`/api/v1/favorites/questions/${q}`).set('X-Q2A-Request', '1').send({})));
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM qa_userfavorites WHERE entitytype='Q' AND entityid=?", [q]);
    expect(Number(n)).toBe(USERS - 1);
    expect(await newViolations()).toEqual({});
  });

  test('a storm of mixed changes on one question leaves everything consistent', async () => {
    const answers = (await pool.query("SELECT postid FROM qa_posts WHERE parentid=? AND type='A' ORDER BY postid", [q]))[0].map(r => r.postid);
    const requests = [];
    others.forEach((d, i) => {
      const target = answers[i % answers.length];
      requests.push(() => d._client.put(`/api/v1/posts/${target}/vote`).set('X-Q2A-Request', '1').send({ vote: i % 3 === 0 ? -1 : 1 }));
      requests.push(() => d._client.post(`/api/v1/posts/${target}/comments`).set('X-Q2A-Request', '1').send({ content: `Storm comment ${i} ${suffix}`, format: '', notify: false, email: '', name: '' }));
      requests.push(() => d._client.put(`/api/v1/posts/${q}/vote`).set('X-Q2A-Request', '1').send({ vote: i % 2 ? 1 : 0 }));
    });
    requests.push(() => owner._client.put(`/api/v1/questions/${q}/selected-answer`).set('X-Q2A-Request', '1').send({ answerId: answers[1] }));
    requests.push(() => owner._client.put(`/api/v1/questions/${q}/selected-answer`).set('X-Q2A-Request', '1').send({ answerId: answers[2] }));
    await together('storm', requests);
    expect(await newViolations()).toEqual({});
  });
});
