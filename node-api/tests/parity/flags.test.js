// Flag parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each flag,
// unflag and clear flags on identical posts, through the question page's buttons. Outcomes, page
// messages and everything app/votes.php writes (the user's flag, flag counts, the flagged-posts
// total, rate limits, the last write) must match, including posts hidden once enough flags arrive.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable } = require('./post-helpers');

describe('PHP ↔ Node flag parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;
  const saved = new Map();

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    // The shared UI and the API reach the Node database from one IP; lift the hourly IP flag limit
    // for this suite so earlier runs cannot use it up.
    for (const pool of [phpPool, nodePool]) {
      await pool.query("DELETE FROM qa_iplimits WHERE action IN ('Q','A','C')");
      const [[row]] = await pool.execute("SELECT content FROM qa_options WHERE title='max_rate_ip_flags'");
      saved.set(pool, row?.content);
      await pool.execute("INSERT INTO qa_options (title,content) VALUES ('max_rate_ip_flags','1000') ON DUPLICATE KEY UPDATE content='1000'");
    }
    backends = [];
    for (const [tag, make] of [
      ['p', () => siteDriver('php', PHP_URL, phpPool)],
      ['u', () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', () => apiDriver(nodePool)],
    ]) {
      const drivers = { owner: make(), actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `f${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(drivers.actor.pool, handles, token);
      const made = async promise => { const outcome = await promise; if (!outcome.accepted) throw new Error(`${tag}: fixture post rejected ${JSON.stringify(outcome)}`); return outcome.id; };
      // Posts that get hidden by flags, created through each backend's own create path.
      ids.qf = await made(drivers.owner.ask({ title: `Flagging ${token} a question until hidden`, content: 'Is this question on topic here?', tags: 'flags' }));
      ids.cf = await made(drivers.owner.comment(ids.qa, ids.a, { content: `A comment for ${token} that collects flags.` }));
      ids.af = await made(drivers.owner.answer(ids.q, { content: `An answer for ${token} that collects flags.` }));
      backends.push({ ...drivers, handles, ids, users, token, tag });
    }
  });
  afterAll(async () => {
    for (const [pool, content] of saved) {
      if (content === undefined) await pool.execute("DELETE FROM qa_options WHERE title='max_rate_ip_flags'");
      else await pool.execute("UPDATE qa_options SET content=? WHERE title='max_rate_ip_flags'", [content]);
    }
    await Promise.all([phpPool.end(), nodePool.end()]);
  });

  async function runEverywhere(perform) {
    const results = [];
    for (const backend of backends) {
      const before = await snapshot(backend);
      const outcome = await perform(backend);
      const after = await snapshot(backend, outcome.id, outcome.id);
      results.push({ outcome, state: comparable(before, after) });
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.outcome.message).toBe(php.outcome.message);
    const shared = state => ({ ...state, tagcountConsistent: undefined });
    expect(shared(ui.state)).toEqual(shared(php.state));
    expect(shared(api.state)).toEqual(shared(php.state));
    if (php.outcome.accepted) expect(ui.outcome.backend).toBe('node-api-v1');
    return { php, ui, api };
  }
  const withOptions = async (values, work) => {
    const previous = [];
    for (const pool of [phpPool, nodePool]) {
      const old = {};
      for (const [title, content] of Object.entries(values)) {
        const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [title]);
        old[title] = row?.content;
        await pool.execute('INSERT INTO qa_options (title,content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [title, content]);
      }
      previous.push([pool, old]);
    }
    try { return await work(); } finally {
      for (const [pool, old] of previous) {
        for (const [title, content] of Object.entries(old)) {
          if (content === undefined) await pool.execute('DELETE FROM qa_options WHERE title=?', [title]);
          else await pool.execute('UPDATE qa_options SET content=? WHERE title=?', [content, title]);
        }
      }
    }
  };
  const setLevel = (label, level) => Promise.all(backends.map(b => b.actor.pool.execute('UPDATE qa_users SET level=? WHERE userid=?', [level, b.users[label]])));

  describe('flagging and unflagging', () => {
    test('a user flags a question', async () => {
      const { php, api } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.q, 'Q', 'flag'));
      expect(php.outcome.accepted).toBe(true);
      expect(api.outcome.accepted).toBe(true);
      expect(php.state.posts.q).toMatchObject({ type: 'Q', flagcount: 1 });
      expect(php.state.caches.cache_flaggedcount).toBe(1);
      expect(php.state.limits.F[0]).toBe(1);
      expect(php.state.uservotes).toContain(JSON.stringify({ postid: 'q', userid: 'actor', vote: 0, flag: 1 }));
    });
    test('the same user has no flag button for a post they already flagged', async () => {
      const { php, api } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.q, 'Q', 'flag'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'flag_not_allowed' });
    });
    test('the author cannot flag their own post', async () => {
      const { api } = await runEverywhere(b => b.owner.act(b.ids.q, b.ids.q, 'Q', 'flag'));
      expect(api.outcome).toMatchObject({ status: 403, code: 'flag_not_allowed' });
    });
    test('anonymous visitors get no flag button', async () => {
      const { api } = await runEverywhere(b => (b.tag === 'n' ? apiDriver(nodePool) : siteDriver(b.actor.name, b.tag === 'p' ? PHP_URL : UI_URL, b.actor.pool)).act(b.ids.q, b.ids.q, 'Q', 'flag'));
      expect(api.outcome).toMatchObject({ status: 403, code: 'flag_not_allowed' });
    });
    test('the user takes their flag back', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.q, 'Q', 'unflag'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.q).toMatchObject({ flagcount: 0 });
      expect(php.state.caches.cache_flaggedcount).toBe(-1);
      expect(php.state.limits.F[0]).toBe(0);
    });
    test('unflagging a post the user never flagged is not offered', async () => {
      const { api } = await runEverywhere(b => b.other.act(b.ids.q, b.ids.q, 'Q', 'unflag'));
      expect(api.outcome).toMatchObject({ status: 403, code: 'unflag_not_allowed' });
    });
    test('the hourly flag limit stops another flag', async () => {
      const { php, api } = await withOptions({ max_rate_user_flags: '0' }, () => runEverywhere(b => b.actor.act(b.ids.qa, b.ids.c1, 'C', 'flag')));
      expect(php.outcome.accepted).toBe(false);
      expect(php.outcome.message).toBe('Too many posts flagged - please try again in an hour');
      expect(api.outcome).toMatchObject({ status: 429, code: 'flag_limit' });
    });
  });

  describe('clearing flags', () => {
    test('two users flag an answer', async () => {
      await runEverywhere(b => b.actor.act(b.ids.qa, b.ids.a, 'A', 'flag'));
      const { php } = await runEverywhere(b => b.other.act(b.ids.qa, b.ids.a, 'A', 'flag'));
      expect(php.state.posts.a).toMatchObject({ type: 'A', flagcount: 2 });
    });
    test('a user without hide permission cannot clear them', async () => {
      const { api } = await runEverywhere(b => b.actor.act(b.ids.qa, b.ids.a, 'A', 'clearflags'));
      expect(api.outcome).toMatchObject({ status: 403, code: 'clearflags_not_allowed' });
    });
    test('an editor clears all flags', async () => {
      await setLevel('other', 50);
      try {
        const { php } = await runEverywhere(b => b.other.act(b.ids.qa, b.ids.a, 'A', 'clearflags'));
        expect(php.outcome.accepted).toBe(true);
        expect(php.state.posts.a).toMatchObject({ flagcount: 0 });
        // Q2A subtracts one per cleared flag from the flagged-posts total.
        expect(php.state.caches.cache_flaggedcount).toBe(-2);
      } finally { await setLevel('other', 0); }
    });
  });

  describe('posts hidden by flags', () => {
    const hideAfterTwo = work => withOptions({ flagging_hide_after: '2' }, work);
    test('the flag that reaches the threshold hides a question', async () => {
      await hideAfterTwo(async () => {
        await runEverywhere(b => b.actor.act(b.ids.qf, b.ids.qf, 'Q', 'flag'));
        const { php } = await runEverywhere(b => b.other.act(b.ids.qf, b.ids.qf, 'Q', 'flag'));
        expect(php.outcome.accepted).toBe(true);
        expect(php.state.posts.qf).toMatchObject({ type: 'Q_HIDDEN', flagcount: 2 });
        expect(php.state.caches.cache_qcount).toBe(-1);
      });
    });
    test('the flag that reaches the threshold hides an answer', async () => {
      await hideAfterTwo(async () => {
        await runEverywhere(b => b.actor.act(b.ids.q, b.ids.af, 'A', 'flag'));
        const { php } = await runEverywhere(b => b.other.act(b.ids.q, b.ids.af, 'A', 'flag'));
        expect(php.state.posts.af).toMatchObject({ type: 'A_HIDDEN', flagcount: 2 });
        expect(php.state.caches.cache_acount).toBe(-1);
      });
    });
    test('the flag that reaches the threshold hides a comment', async () => {
      await hideAfterTwo(async () => {
        await runEverywhere(b => b.actor.act(b.ids.qa, b.ids.cf, 'C', 'flag'));
        const { php } = await runEverywhere(b => b.other.act(b.ids.qa, b.ids.cf, 'C', 'flag'));
        expect(php.state.posts.cf).toMatchObject({ type: 'C_HIDDEN', flagcount: 2 });
      });
    });
    test('a hidden post with flags cannot be reshown by its author', async () => {
      const { api } = await runEverywhere(b => b.owner.act(b.ids.qf, b.ids.qf, 'Q', 'reshow'));
      expect(api.outcome).toMatchObject({ status: 403, code: 'reshow_not_allowed' });
    });
  });
});
