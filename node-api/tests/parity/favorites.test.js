// Favorite parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each add
// and remove favorite questions, users and tags with the pages' favorite buttons. Outcomes and
// everything app/favorites.php and db/favorites.php write (favorites, the events copied into each
// user's update stream, the switch to shared streams, the user's last write) must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable } = require('./post-helpers');

describe('PHP ↔ Node favorite parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action IN ('Q','A','C')");
    backends = [];
    for (const [tag, make] of [
      ['p', () => siteDriver('php', PHP_URL, phpPool)],
      ['u', () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', () => apiDriver(nodePool)],
    ]) {
      const drivers = { owner: make(), actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `v${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(drivers.actor.pool, handles, token);
      const made = async promise => { const outcome = await promise; if (!outcome.accepted) throw new Error(`${tag}: fixture post rejected`); return outcome.id; };
      // Questions with update events, created through each backend's own create path.
      const tagword = `fav${token}`;
      ids.qt = await made(drivers.owner.ask({ title: `Favoriting ${token} a question to follow`, content: 'What should I follow to learn databases?', tags: tagword }));
      ids.qs = await made(drivers.owner.ask({ title: `Sharing ${token} a popular question`, content: 'Which questions get many followers here?', tags: tagword }));
      await made(drivers.other.answer(ids.qt, { content: `Follow the ${token} tag and a few experts.` }));
      const [[word]] = await drivers.actor.pool.execute('SELECT wordid FROM qa_words WHERE word=?', [tagword]);
      backends.push({ ...drivers, handles, ids, users, token, tag, tagword, wordid: word.wordid });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  async function runEverywhere(perform) {
    const results = [];
    for (const backend of backends) {
      const before = await snapshot(backend);
      const outcome = await perform(backend);
      const after = await snapshot(backend);
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
  const favoriteOf = (state, entitytype, entityid, userid = 'actor') =>
    state.favorites.map(row => JSON.parse(row)).find(row => row.userid === userid && row.entitytype === entitytype && row.entityid === entityid);

  test('a user adds a question to their favorites', async () => {
    const { php } = await runEverywhere(b => b.actor.favorite(b.ids.qt, 'Q', b.ids.qt, true));
    expect(php.outcome.accepted).toBe(true);
    // The question's recent shared events are copied into the user's own stream.
    expect(favoriteOf(php.state, 'Q', 'qt')).toMatchObject({ nouserevents: 0 });
    expect(favoriteOf(php.state, 'Q', 'qt').events).toBeGreaterThan(0);
    expect(php.state.writers.actor).toBe(1);
  });
  test('the user removes it again', async () => {
    const { php } = await runEverywhere(b => b.actor.favorite(b.ids.qt, 'Q', b.ids.qt, false));
    expect(php.outcome.accepted).toBe(true);
    expect(favoriteOf(php.state, 'Q', 'qt')).toBeUndefined();
  });
  test('a user follows another user from their profile', async () => {
    const { php } = await runEverywhere(b => b.actor.favorite(`/index.php?qa=user/${b.handles.owner}`, 'U', b.users.owner, true));
    expect(php.outcome.accepted).toBe(true);
    expect(favoriteOf(php.state, 'U', 'owner')).toMatchObject({ nouserevents: 0 });
  });
  test('the user unfollows them with the ajax button', async () => {
    const { php } = await runEverywhere(b => (b.tag === 'n'
      ? b.actor.favorite(null, 'U', b.users.owner, false)
      : b.actor.favoriteAjax(`/index.php?qa=user/${b.handles.owner}`, 'U', b.users.owner, false)));
    expect(php.outcome.accepted).toBe(true);
    expect(favoriteOf(php.state, 'U', 'owner')).toBeUndefined();
  });
  test('and follows them again the same way', async () => {
    const { php } = await runEverywhere(b => (b.tag === 'n'
      ? b.actor.favorite(null, 'U', b.users.owner, true)
      : b.actor.favoriteAjax(`/index.php?qa=user/${b.handles.owner}`, 'U', b.users.owner, true)));
    expect(favoriteOf(php.state, 'U', 'owner')).toMatchObject({ nouserevents: 0 });
  });
  test('a user cannot follow themselves', async () => {
    const { api } = await runEverywhere(b => b.actor.favorite(`/index.php?qa=user/${b.handles.actor}`, 'U', b.users.actor, true));
    expect(api.outcome).toMatchObject({ status: 403, code: 'favorite_not_allowed' });
  });
  test('a user adds a tag to their favorites', async () => {
    const { php } = await runEverywhere(b => b.actor.favorite(`/index.php?qa=tag/${b.tagword}`, 'T', b.wordid, true));
    expect(php.outcome.accepted).toBe(true);
    expect(favoriteOf(php.state, 'T', 'fav<token>')).toMatchObject({ nouserevents: 0 });
  });
  test('anonymous visitors get no favorite button', async () => {
    const visitor = b => (b.tag === 'n' ? apiDriver(nodePool) : siteDriver(b.actor.name, b.tag === 'p' ? PHP_URL : UI_URL, b.actor.pool));
    const { api } = await runEverywhere(b => visitor(b).favorite(b.ids.qt, 'Q', b.ids.qt, true));
    expect(api.outcome).toMatchObject({ status: 401, code: 'unauthenticated' });
  });
  test('enough followers switch a question to its shared update stream', async () => {
    await withOptions({ max_copy_user_updates: '2' }, async () => {
      const first = await runEverywhere(b => b.actor.favorite(b.ids.qs, 'Q', b.ids.qs, true));
      expect(favoriteOf(first.php.state, 'Q', 'qs')).toMatchObject({ nouserevents: 0 });
      const { php } = await runEverywhere(b => b.other.favorite(b.ids.qs, 'Q', b.ids.qs, true));
      expect(favoriteOf(php.state, 'Q', 'qs')).toMatchObject({ nouserevents: 1 });
      expect(favoriteOf(php.state, 'Q', 'qs', 'other')).toMatchObject({ nouserevents: 1, events: 0 });
    });
  });
  test('the shared-stream threshold rises for users who already follow shared streams', async () => {
    await withOptions({ max_copy_user_updates: '1' }, async () => {
      // The shared UI and the API share one database, and the favorite raises this site-wide option.
      const { php } = await runEverywhere(async b => {
        await b.actor.pool.execute("UPDATE qa_options SET content='1' WHERE title='max_copy_user_updates'");
        return b.actor.favorite(b.ids.qt, 'Q', b.ids.qt, true);
      });
      expect(favoriteOf(php.state, 'Q', 'qt')).toMatchObject({ nouserevents: 1 });
      expect(php.state.maxCopyUserUpdates).toBe('2');
    });
  });
});
