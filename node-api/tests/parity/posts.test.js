// Posting parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each
// ask questions, answer and comment against identical fixture posts. Outcomes, the messages the
// pages show, and every database value qa_question_create(), qa_answer_create() and
// qa_comment_create() write (including the word index, cached counts, points, rate limits,
// update streams and visitor cookies) must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable } = require('./post-helpers');

describe('PHP ↔ Node posting parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    // Start from a fresh hour for the shared test address: repeated runs would otherwise reach
    // the per-IP question limit (the UI and API runs both count against the Node database).
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action IN ('Q','A','C')");
    backends = [];
    for (const [tag, make] of [
      ['p', pool => siteDriver('php', PHP_URL, pool), () => phpPool],
      ['u', pool => siteDriver('migrated-ui', UI_URL, pool), () => nodePool],
      ['n', pool => apiDriver(pool), () => nodePool],
    ].map(([t, m, p]) => [t, () => m(p())])) {
      const drivers = { owner: make(), actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `p${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(drivers.actor.pool, handles, token);
      backends.push({ ...drivers, handles, ids, users, token, tag });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  // Runs one operation on each backend in turn and compares outcomes and database changes.
  async function runEverywhere(perform) {
    const results = [];
    for (const backend of backends) {
      const before = await snapshot(backend);
      const outcome = await perform(backend);
      if (outcome.accepted && !outcome.id) throw new Error(`${backend.tag}: accepted without a post ID`);
      const after = await snapshot(backend, outcome.id);
      results.push({ outcome, state: comparable(before, after) });
      if (outcome.accepted) backend.ids[`made${Object.keys(backend.ids).length}`] = outcome.id;
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.outcome.message).toBe(php.outcome.message);
    // cache_tagcount is a site-wide recount whose staleness depends on each database's history.
    const shared = state => ({ ...state, tagcountConsistent: undefined });
    expect(shared(ui.state)).toEqual(shared(php.state));
    expect(shared(api.state)).toEqual(shared(php.state));
    if (php.outcome.accepted) expect(ui.outcome.backend).toBe('node-api-v1');
    return { php, ui, api };
  }
  const withOptions = async (values, work) => {
    const previous = [];
    for (const pool of [phpPool, nodePool]) {
      const saved = {};
      for (const [title, content] of Object.entries(values)) {
        const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [title]);
        saved[title] = row?.content;
        await pool.execute('INSERT INTO qa_options (title,content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [title, content]);
      }
      previous.push([pool, saved]);
    }
    try { return await work(); } finally {
      for (const [pool, saved] of previous) {
        for (const [title, content] of Object.entries(saved)) {
          if (content === undefined) await pool.execute('DELETE FROM qa_options WHERE title=?', [title]);
          else await pool.execute('UPDATE qa_options SET content=? WHERE title=?', [content, title]);
        }
      }
    }
  };
  const question = b => ({
    title: `How do I profile ${b.token} slow queries?`, content: `My report page takes 4 seconds; the query plan shows a full scan on ${b.token} orders.`,
    tags: 'mysql performance indexing', notify: true, email: '',
  });

  describe('questions', () => {
    test('asks a question with tags', async () => {
      const { php } = await runEverywhere(b => b.actor.ask(question(b)));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.new).toMatchObject({ type: 'Q', userid: 'actor', notify: '@', tags: 'mysql,performance,indexing', hotnessOk: true });
      expect(php.state.caches).toMatchObject({ cache_qcount: 1, cache_unaqcount: 1, cache_unselqcount: 1, cache_unupaqcount: 1 });
      expect(php.state.limits.Q).toEqual([1, 1]);
      expect(php.state.tagcountConsistent).toBe(true);
    });
    test('rejects a duplicate of a recent question', async () => {
      const { php, api } = await runEverywhere(b => b.actor.ask(question(b)));
      expect(php.outcome).toMatchObject({ accepted: false, message: 'Your submission appears to be a duplicate.' });
      expect(api.outcome).toMatchObject({ status: 409, code: 'duplicate_content' });
    });
    test('asks a question written in the HTML editor', async () => {
      const { php } = await runEverywhere(b => b.actor.ask({
        title: `Formatting ${b.token} code in answers`, content: `<p>Is <strong>bold</strong> text kept in ${b.token} posts?</p><ul><li>one</li><li>two</li></ul>`,
        format: 'html', tags: 'html editor',
      }));
      expect(php.state.posts.new).toMatchObject({ format: 'html', notify: null });
    });
    test.each([
      ['a title that is too short', b => ({ title: 'Short', content: 'Body text for this question.', tags: 'x' }), { title: 'min_length' }],
      ['too many tags', b => ({ title: `Too many tags ${b.token} here`, content: 'Body', tags: 'one two three four five six' }), { tags: 'max_tags' }],
      ['an invalid notification email', b => ({ title: `Notify email ${b.token} check`, content: 'Body', tags: 'x', notify: true, email: 'not-an-email' }), { email: 'invalid' }],
    ])('rejects %s', async (name, input, fields) => {
      const { php, api } = await runEverywhere(b => b.actor.ask(input(b)));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields });
    });
    test('an anonymous visitor asks a question under a chosen name', async () => {
      const { php } = await runEverywhere(b => {
        const visitor = b.tag === 'n' ? apiDriver(b.actor.pool) : siteDriver(b.actor.name, b.tag === 'p' ? PHP_URL : UI_URL, b.actor.pool);
        return visitor.ask({ title: `Anonymous ${b.token} question title`, content: 'Asked without an account.', tags: 'guest', name: 'Guest Asker' });
      });
      expect(php.state.posts.new).toMatchObject({ userid: null, cookieid: true, name: 'Guest Asker' });
      expect(php.state.cookies).toHaveLength(1);
    });
    test('a follow-on question links to the answer it came from', async () => {
      const { php } = await runEverywhere(b => b.actor.ask({
        followAnswerId: b.ids.a, title: `Follow-up ${b.token} on composite indexes`, content: 'What column order should the index use?', tags: 'mysql',
      }));
      expect(php.state.posts.new).toMatchObject({ parentid: 'a' });
      expect(php.state.events.personal.some(row => row.includes('"updatetype":"F"'))).toBe(true);
    });
    test('goes to the moderation queue when unapproved users are moderated', async () => {
      const { php } = await withOptions({ moderate_users: '1', moderate_unapproved: '1' }, () => runEverywhere(b => b.actor.ask({
        title: `Queued ${b.token} question for review`, content: 'Waiting for a moderator.', tags: 'queue',
      })));
      expect(php.state.posts.new).toMatchObject({ type: 'Q_QUEUED' });
      expect(php.state.caches).toMatchObject({ cache_queuedcount: 1, cache_qcount: 0 });
      expect(php.state.index.title).toEqual([]);
    });
    test('enforces the hourly question limit', async () => {
      for (const b of backends) {
        await b.actor.pool.execute("INSERT INTO qa_userlimits (userid,action,period,count) VALUES (?, 'Q', FLOOR(UNIX_TIMESTAMP()/3600), 60000) ON DUPLICATE KEY UPDATE period=VALUES(period), count=60000", [b.users.actor]);
      }
      try {
        const { php, api } = await runEverywhere(b => b.actor.ask({ title: `Over the limit ${b.token} question`, content: 'Body', tags: 'x' }));
        expect(php.outcome.message).toBe('Too many questions received - please try again in an hour');
        expect(api.outcome).toMatchObject({ status: 429, code: 'ask_limit' });
      } finally {
        for (const b of backends) await b.actor.pool.execute("DELETE FROM qa_userlimits WHERE userid=? AND action='Q'", [b.users.actor]);
      }
    });
    test('blocked users cannot ask', async () => {
      const setBlocked = on => Promise.all(backends.map(b => b.actor.pool.execute(`UPDATE qa_users SET flags = flags ${on ? '| 2' : '& ~2'} WHERE userid=?`, [b.users.actor])));
      await setBlocked(true);
      try {
        const { php, api } = await runEverywhere(b => b.actor.ask({ title: `Blocked user ${b.token} question`, content: 'Body', tags: 'x' }));
        expect(php.outcome.message).toBe('You do not have permission to perform this operation');
        expect(api.outcome).toMatchObject({ status: 403, code: 'no_permission' });
      } finally { await setBlocked(false); }
    });
  });

  describe('answers', () => {
    const answer = b => ({ content: `Run EXPLAIN on the ${b.token} query and add an index for the WHERE clause.`, notify: true });
    test('answers an unanswered question', async () => {
      const { php } = await runEverywhere(b => b.actor.answer(b.ids.q, answer(b)));
      expect(php.state.posts.new).toMatchObject({ type: 'A', parentid: 'q', userid: 'actor' });
      expect(php.state.posts.q).toMatchObject({ acount: 1, hotnessOk: true });
      expect(php.state.caches).toMatchObject({ cache_acount: 1, cache_unaqcount: -1 });
      expect(php.state.limits.A).toEqual([1, 1]);
    });
    test('rejects a duplicate answer', async () => {
      const { php, api } = await runEverywhere(b => b.actor.answer(b.ids.q, answer(b)));
      expect(php.outcome.message).toBe('Your submission appears to be a duplicate.');
      expect(api.outcome).toMatchObject({ status: 409, code: 'duplicate_content' });
    });
    test('a second answer by another user keeps the unanswered total', async () => {
      const { php } = await runEverywhere(b => b.other.answer(b.ids.q, { content: 'A covering index avoids reading the table rows at all.' }));
      expect(php.state.caches).toMatchObject({ cache_acount: 1, cache_unaqcount: 0 });
    });
    test('rejects an answer that is too short', async () => {
      const { php, api } = await runEverywhere(b => b.actor.answer(b.ids.q, { content: 'Too short' }));
      expect(php.outcome.message).toBe('Please provide more information - at least 12 characters');
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { content: 'min_length' } });
    });
    test('rejects answering a hidden question', async () => {
      const { php, api } = await runEverywhere(b => b.actor.answer(b.ids.hidden, answer(b)));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'question_not_viewable' });
    });
    test('an anonymous visitor answers', async () => {
      const { php } = await runEverywhere(b => {
        const visitor = b.tag === 'n' ? apiDriver(b.actor.pool) : siteDriver(b.actor.name, b.tag === 'p' ? PHP_URL : UI_URL, b.actor.pool);
        return visitor.answer(b.ids.qa, { content: 'Partitioning the table could also help with this.', name: 'Guest Helper' });
      });
      expect(php.state.posts.new).toMatchObject({ userid: null, cookieid: true, name: 'Guest Helper' });
    });
  });

  describe('comments', () => {
    test('comments on an answer, notifying the author and earlier commenters', async () => {
      const { php } = await runEverywhere(b => b.actor.comment(b.ids.qa, b.ids.a, { content: 'A covering index worked well for me too.' }));
      expect(php.state.posts.new).toMatchObject({ type: 'C', parentid: 'a' });
      expect(php.state.caches).toMatchObject({ cache_ccount: 1 });
      expect(php.state.events.personal).toEqual(expect.arrayContaining([
        expect.stringContaining('"userid":"other"'), expect.stringContaining('"userid":"owner"'),
      ]));
    });
    test('rejects commenting on a question while question comments are off', async () => {
      const { php, api } = await runEverywhere(b => b.actor.comment(b.ids.q, b.ids.q, { content: 'Comment on the question itself.' }));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'comment_not_allowed' });
    });
    test('comments on a question once question comments are on', async () => {
      const { php } = await withOptions({ comment_on_qs: '1' }, () =>
        runEverywhere(b => b.other.comment(b.ids.q, b.ids.q, { content: 'Could you share the query plan output?' })));
      expect(php.state.posts.new).toMatchObject({ type: 'C', parentid: 'q' });
    });
    test('rejects a comment that is too short', async () => {
      const { php, api } = await runEverywhere(b => b.actor.comment(b.ids.qa, b.ids.a, { content: 'Nope' }));
      expect(php.outcome.message).toBe('Please provide more information - at least 12 characters');
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { content: 'min_length' } });
    });
  });
});
