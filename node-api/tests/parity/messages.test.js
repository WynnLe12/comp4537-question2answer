// Private message and wall parity: the original PHP site, the shared Q2A UI backed by Node, and the
// Node API each send private messages, post on walls and delete both, through the real pages.
// Outcomes, page messages and everything written (messages, hidden flags, wall post counts, the
// message and wall rate limits, the user's last write) must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable } = require('./post-helpers');

describe('PHP ↔ Node message and wall parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    // The shared UI and the API reach the Node database from one IP; start each run with fresh IP limits.
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action IN ('M','W')");
    backends = [];
    for (const [tag, make] of [
      ['p', () => siteDriver('php', PHP_URL, phpPool)],
      ['u', () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', () => apiDriver(nodePool)],
    ]) {
      const drivers = { owner: make(), actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `m${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(drivers.actor.pool, handles, token);
      backends.push({ ...drivers, handles, ids, users, token, tag });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  async function runEverywhere(perform) {
    const results = [];
    for (const backend of backends) {
      const before = await snapshot(backend);
      const outcome = await perform(backend);
      // Page messages can name a user; each backend has its own test users.
      if (typeof outcome.message === 'string') {
        for (const [label, handle] of Object.entries(backend.handles)) outcome.message = outcome.message.split(handle).join(`<${label}>`);
      }
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
  const withUserFlags = async (label, flags, work) => {
    await Promise.all(backends.map(b => b.actor.pool.execute('UPDATE qa_users SET flags=flags|? WHERE userid=?', [flags, b.users[label]])));
    try { return await work(); } finally {
      await Promise.all(backends.map(b => b.actor.pool.execute('UPDATE qa_users SET flags=flags&~? WHERE userid=?', [flags, b.users[label]])));
    }
  };
  const latestMessage = async (b, type, from, to) => {
    const [[row]] = await b.actor.pool.execute('SELECT messageid FROM qa_messages WHERE type=? AND fromuserid=? AND touserid=? ORDER BY messageid DESC LIMIT 1', [type, b.users[from], b.users[to]]);
    return row.messageid;
  };
  const visitor = b => (b.tag === 'n' ? apiDriver(nodePool) : siteDriver(b.actor.name, b.tag === 'p' ? PHP_URL : UI_URL, b.actor.pool));
  const parsed = state => state.messages.map(row => JSON.parse(row));

  describe('private messages', () => {
    test('a user sends a private message', async () => {
      const { php } = await runEverywhere(b => b.actor.sendMessage(b.handles.owner, `Hello from ${b.token}, can we talk about caching?`));
      expect(php.outcome.accepted).toBe(true);
      expect(parsed(php.state)).toContainEqual({ type: 'PRIVATE', fromuserid: 'actor', touserid: 'owner', fromhidden: 0, tohidden: 0, content: 'Hello from <token>, can we talk about caching?', format: '' });
      expect(php.state.limits.M[0]).toBe(1);
      expect(php.state.writers.actor).toBe(1);
    });
    test('an empty message is refused', async () => {
      const { php, api } = await runEverywhere(b => b.actor.sendMessage(b.handles.owner, ''));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { content: 'required' } });
    });
    test('users cannot message themselves', async () => {
      const { api } = await runEverywhere(b => b.actor.sendMessage(b.handles.actor, 'Note to self.'));
      expect(api.outcome).toMatchObject({ status: 403, code: 'no_permission' });
    });
    test('a user who switched off private messages cannot be messaged', async () => {
      const { php, api } = await withUserFlags('owner', 16, () => runEverywhere(b => b.actor.sendMessage(b.handles.owner, 'Are you there?')));
      expect(php.outcome.message).toMatch(/private messages/i);
      expect(api.outcome).toMatchObject({ status: 403, code: 'messages_disabled' });
    });
    test('the hourly message limit stops another message', async () => {
      const { php, api } = await withOptions({ max_rate_user_messages: '0' }, () => runEverywhere(b => b.actor.sendMessage(b.handles.owner, 'One more thing.')));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 429, code: 'message_limit' });
    });
    test('without message history the message is only counted, not stored', async () => {
      const { php } = await withOptions({ show_message_history: '0' }, () => runEverywhere(b => b.other.sendMessage(b.handles.owner, `Unstored ${b.token} message.`)));
      expect(php.outcome.accepted).toBe(true);
      expect(parsed(php.state).some(row => row.content === 'Unstored <token> message.')).toBe(false);
    });
    test('anonymous visitors must log in', async () => {
      const { api } = await runEverywhere(b => visitor(b).sendMessage(b.handles.owner, 'Hello?'));
      expect(api.outcome).toMatchObject({ status: 401, code: 'unauthenticated' });
    });
    test('the recipient deletes it from their inbox; it stays in the outbox', async () => {
      const { php } = await runEverywhere(async b => b.owner.deleteMessage('inbox', await latestMessage(b, 'PRIVATE', 'actor', 'owner')));
      expect(php.outcome.accepted).toBe(true);
      expect(parsed(php.state).find(row => row.type === 'PRIVATE' && row.fromuserid === 'actor')).toMatchObject({ tohidden: 1, fromhidden: 0 });
    });
    test('another user cannot delete it', async () => {
      const { api } = await runEverywhere(async b => b.other.deleteMessage('outbox', await latestMessage(b, 'PRIVATE', 'actor', 'owner')));
      expect(api.outcome).toMatchObject({ status: 404, code: 'message_not_found' });
    });
    test('once the sender deletes it too, it is removed', async () => {
      const { php } = await runEverywhere(async b => b.actor.deleteMessage('outbox', await latestMessage(b, 'PRIVATE', 'actor', 'owner')));
      expect(php.outcome.accepted).toBe(true);
      expect(parsed(php.state).some(row => row.type === 'PRIVATE' && row.fromuserid === 'actor')).toBe(false);
    });
  });

  describe('wall posts', () => {
    test('a user posts on another user\'s wall', async () => {
      const { php } = await runEverywhere(b => b.actor.wallPost(b.handles.owner, `Welcome ${b.token} to the site!`));
      expect(php.outcome.accepted).toBe(true);
      expect(parsed(php.state)).toContainEqual({ type: 'PUBLIC', fromuserid: 'actor', touserid: 'owner', fromhidden: 0, tohidden: 0, content: 'Welcome <token> to the site!', format: '' });
      expect(php.state.wallposts.owner).toBeGreaterThan(0);
      expect(php.state.limits.W[0]).toBe(1);
    });
    test('an empty wall post is refused', async () => {
      const { php, api } = await runEverywhere(b => b.actor.wallPost(b.handles.owner, ''));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { content: 'required' } });
    });
    test('a user who blocked wall posts gets none', async () => {
      const { php, api } = await withUserFlags('owner', 256, () => runEverywhere(b => b.actor.wallPost(b.handles.owner, 'Hi!')));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'wall_blocked' });
    });
    test('the hourly wall limit stops another post', async () => {
      const { api } = await withOptions({ max_rate_user_messages: '0' }, () => runEverywhere(b => b.actor.wallPost(b.handles.owner, 'Again!')));
      expect(api.outcome).toMatchObject({ status: 429, code: 'wall_limit' });
    });
    test('another user cannot delete it', async () => {
      const { api } = await runEverywhere(async b => b.other.deleteWallPost(b.handles.owner, await latestMessage(b, 'PUBLIC', 'actor', 'owner')));
      expect(api.outcome).toMatchObject({ status: 403, code: 'delete_not_allowed' });
    });
    test('the author deletes their own latest post', async () => {
      const { php } = await runEverywhere(async b => b.actor.deleteWallPost(b.handles.owner, await latestMessage(b, 'PUBLIC', 'actor', 'owner')));
      expect(php.outcome.accepted).toBe(true);
      expect(parsed(php.state).some(row => row.type === 'PUBLIC' && row.fromuserid === 'actor')).toBe(false);
    });
    test('after someone replies, the author can no longer delete it', async () => {
      await runEverywhere(b => b.actor.wallPost(b.handles.owner, `First ${b.token} post.`));
      // Walls are ordered by creation time, in whole seconds; make the reply clearly newer.
      for (const b of backends) {
        await b.actor.pool.execute('UPDATE qa_messages SET created = created - INTERVAL 1 MINUTE WHERE messageid=?', [await latestMessage(b, 'PUBLIC', 'actor', 'owner')]);
      }
      await runEverywhere(b => b.other.wallPost(b.handles.owner, `Reply ${b.token} post.`));
      const { api } = await runEverywhere(async b => b.actor.deleteWallPost(b.handles.owner, await latestMessage(b, 'PUBLIC', 'actor', 'owner')));
      expect(api.outcome).toMatchObject({ status: 403, code: 'delete_not_allowed' });
    });
    test('the wall owner deletes any post on their wall', async () => {
      // With JavaScript on, the delete button goes through ajax/click-wall.php.
      const { php } = await runEverywhere(async b => {
        const messageid = await latestMessage(b, 'PUBLIC', 'actor', 'owner');
        return b.tag === 'n' ? b.owner.deleteWallPost(b.handles.owner, messageid) : b.owner.deleteWallPostAjax(b.handles.owner, messageid);
      });
      expect(php.outcome.accepted).toBe(true);
    });
  });
});
