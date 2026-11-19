// Recalculation tools parity: the PHP site, the shared UI backed by Node and the Node API each run the
// admin stats page's tools (recount posts, recalculate points and categories, reindex, refill update
// streams, delete hidden posts). Each case first breaks known values on this run's own posts and
// users, then checks that every backend repairs them the same way.
//
// These tools work through the whole database, so this suite takes minutes; it runs when
// RECALC_PARITY=1 is set:  docker compose run --rm -e RECALC_PARITY=1 tests npx jest --runInBand tests/parity/recalc.test.js
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures } = require('./post-helpers');

const run = process.env.RECALC_PARITY === '1' ? describe : describe.skip;
jest.setTimeout(30 * 60 * 1000);

run('PHP ↔ Node recalculation tools parity (stats page tools, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action IN ('Q','A','C','V')");
    backends = [];
    for (const [tag, pool, make] of [
      ['p', phpPool, () => siteDriver('php', PHP_URL, phpPool)],
      ['u', nodePool, () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', nodePool, () => apiDriver(nodePool)],
    ]) {
      const drivers = { owner: make(), actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `r${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(pool, handles, token);
      await pool.execute('UPDATE qa_users SET level=100 WHERE userid=?', [users.actor]);
      const made = async promise => { const outcome = await promise; if (!outcome.accepted) throw new Error(`${tag}: fixture post rejected`); return outcome.id; };
      ids.qr = await made(drivers.owner.ask({ title: `Recalculating ${token} everything`, content: 'Which numbers can be rebuilt?', tags: `recalc${token}` }));
      ids.ar = await made(drivers.other.answer(ids.qr, { content: `All of the cached ${token} ones.` }));
      backends.push({ ...drivers, pool, handles, users, ids, token, tag, mark: `${tag}${suffix}` });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  async function runEverywhere(breakIt, operation, stateOf) {
    const results = [];
    for (const b of backends) {
      await breakIt(b);
      const outcome = await b.actor.recalc(operation);
      results.push({ outcome, state: await stateOf(b) });
    }
    const [php, ui, api] = results;
    expect(php.outcome.accepted).toBe(true);
    expect(ui.outcome.accepted).toBe(true);
    expect(api.outcome.accepted).toBe(true);
    expect(ui.outcome.backend).toBe('node-api-v1');
    expect(ui.state).toEqual(php.state);
    expect(api.state).toEqual(php.state);
    return php.state;
  }
  const posts = async (b, labels, columns) => {
    const out = {};
    for (const label of labels) {
      const [[row]] = await b.pool.query(`SELECT ${columns} FROM qa_posts WHERE postid=?`, [b.ids[label]]);
      out[label] = row ?? null;
    }
    return out;
  };

  test('recounting posts repairs votes, answer counts and flags', async () => {
    const state = await runEverywhere(
      b => b.pool.query('UPDATE qa_posts SET upvotes=9, netvotes=9, acount=5, amaxvote=4, flagcount=3 WHERE postid IN (?)', [[b.ids.qr, b.ids.ar]]),
      'dorecountposts', b => posts(b, ['qr', 'ar'], 'upvotes, downvotes, netvotes, acount, amaxvote, flagcount'));
    expect(state.qr).toMatchObject({ upvotes: 0, netvotes: 0, acount: 1, amaxvote: 0, flagcount: 0 });
  });
  test('recalculating points repairs users\' points', async () => {
    const state = await runEverywhere(
      b => b.pool.query('UPDATE qa_userpoints SET points=1, qposts=40 WHERE userid IN (?)', [[b.users.owner, b.users.other]]),
      'dorecalcpoints', async b => {
        const out = {};
        for (const label of ['owner', 'other']) {
          const [[row]] = await b.pool.query('SELECT points, qposts, aposts FROM qa_userpoints WHERE userid=?', [b.users[label]]);
          out[label] = row;
        }
        return out;
      });
    expect(state.owner).toMatchObject({ qposts: 3 });
  });
  test('recalculating categories repairs answers\' categories', async () => {
    await runEverywhere(
      b => b.pool.query('UPDATE qa_posts SET catidpath1=999 WHERE postid IN (?)', [[b.ids.qr, b.ids.ar]]),
      'dorecalccategories', b => posts(b, ['qr', 'ar'], 'categoryid, catidpath1, catidpath2, catidpath3'));
  });
  test('reindexing rebuilds the search index', async () => {
    await runEverywhere(
      b => b.pool.query('DELETE FROM qa_titlewords WHERE postid=?', [b.ids.qr]),
      'doreindexcontent', async b => {
        const [rows] = await b.pool.query('SELECT w.word FROM qa_titlewords t JOIN qa_words w USING (wordid) WHERE t.postid=? ORDER BY w.word', [b.ids.qr]);
        return rows.map(row => row.word.split(b.mark).join('<b>'));
      });
  });
  test('refilling update streams rebuilds a question\'s events', async () => {
    await runEverywhere(
      b => b.pool.query('DELETE FROM qa_sharedevents WHERE questionid=?', [b.ids.qr]),
      'dorefillevents', async b => {
        const [rows] = await b.pool.query('SELECT entitytype, lastpostid, updatetype, lastuserid FROM qa_sharedevents WHERE questionid=? ORDER BY entitytype, lastpostid, updatetype', [b.ids.qr]);
        const label = id => Object.entries(b.ids).find(([, v]) => Number(v) === Number(id))?.[0] ?? Object.entries(b.users).find(([, v]) => Number(v) === Number(id))?.[0] ?? 'other';
        return [...new Set(rows.map(row => JSON.stringify({ ...row, lastpostid: label(row.lastpostid), lastuserid: row.lastuserid === null ? null : label(row.lastuserid) })))].sort();
      });
  });
  test('deleting hidden posts removes hidden posts with no answers or comments', async () => {
    const state = await runEverywhere(
      async b => {
        const outcome = await b.owner.ask({ title: `Hidden ${b.token} soon`, content: 'This will be hidden and deleted.', tags: 'recalc' });
        b.ids.qh = outcome.id;
        await b.pool.query("UPDATE qa_posts SET type='Q_HIDDEN' WHERE postid=?", [b.ids.qh]);
      },
      'dodeletehidden', b => posts(b, ['qh', 'hidden'], 'type'));
    expect(state.qh).toBeNull();
  });
});
