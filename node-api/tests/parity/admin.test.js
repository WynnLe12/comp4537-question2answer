// Moderation and user administration parity: the original PHP site, the shared Q2A UI backed by Node,
// and the Node API each approve, block, edit, promote, hide and delete users through the profile page
// and the approve-users page, and moderate posts through the admin moderate, flagged and hidden
// pages. Outcomes, page messages, everything written (users, levels, profile fields, cached counts,
// posts, flags, points, update streams) and the emails sent must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable, emailsDuring } = require('./post-helpers');

describe('PHP ↔ Node moderation and user administration parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action IN ('Q','A','C','F')");
    backends = [];
    for (const [tag, pool, make] of [
      ['p', phpPool, () => siteDriver('php', PHP_URL, phpPool)],
      ['u', nodePool, () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', nodePool, () => apiDriver(nodePool)],
    ]) {
      // actor: the admin; other: a moderator; owner: a user with posts; target and voter: new users.
      const drivers = { owner: make(), actor: make(), other: make(), target: make(), voter: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `d${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(pool, handles, token);
      await pool.execute('UPDATE qa_users SET level=100 WHERE userid=?', [users.actor]);
      await pool.execute('UPDATE qa_users SET level=80 WHERE userid=?', [users.other]);
      const made = async promise => { const outcome = await promise; if (!outcome.accepted) throw new Error(`${tag}: fixture post rejected`); return outcome.id; };
      ids.qp = await made(drivers.owner.ask({ title: `Moderating ${token} a user's question`, content: 'A question from a user with posts.', tags: 'admin' }));
      ids.ap = await made(drivers.owner.answer(ids.qp, { content: `An answer ${token} from the same user.` }));
      backends.push({ ...drivers, pool, handles, users, ids, token, tag, mark: `${tag}${suffix}` });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  // Users as the admin pages change them, with each backend's names masked.
  async function userState(b) {
    const mask = value => (typeof value === 'string' ? value.split(b.mark).join('<b>') : value);
    const state = {};
    for (const [label, userid] of Object.entries(b.users)) {
      const [[user = null]] = await b.pool.execute('SELECT handle, email, level, flags, avatarblobid IS NOT NULL AS hasavatar FROM qa_users WHERE userid=?', [userid]);
      const [profile] = await b.pool.execute('SELECT title, content FROM qa_userprofile WHERE userid=? ORDER BY title', [userid]);
      const [levels] = await b.pool.execute('SELECT entitytype, level FROM qa_userlevels WHERE userid=?', [userid]);
      state[label] = user && { ...user, handle: mask(user.handle), email: mask(user.email), profile: profile.map(row => `${row.title}=${mask(row.content)}`), levels: levels.length };
    }
    // The count of users awaiting approval is often recounted, so whether it is right is compared.
    const [[approve]] = await b.pool.query("SELECT (SELECT content FROM qa_options WHERE title='cache_uapprovecount') AS cached, (SELECT COUNT(*) FROM qa_users WHERE level < 10 AND NOT (flags & 2)) AS actual");
    return { users: state, uapprovecountConsistent: Number(approve.cached) === Number(approve.actual) };
  }
  function normalizeEmails(b, emails) {
    return emails.map(email => JSON.stringify({ to: (email.to ?? []).map(t => t.Address.split(b.mark).join('<b>')), subject: email.subject, text: String(email.text).split(b.mark).join('<b>') })).sort();
  }

  async function runEverywhere(perform) {
    const results = [];
    for (const b of backends) {
      const before = { posts: await snapshot(b), users: await userState(b) };
      const { outcome, emails } = await emailsDuring(() => perform(b));
      if (typeof outcome.message === 'string') outcome.message = outcome.message.split(b.mark).join('<b>');
      const users = await userState(b);
      results.push({
        outcome, emails: normalizeEmails(b, emails),
        state: { ...comparable(before.posts, await snapshot(b)), ...users },
      });
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.outcome.message).toBe(php.outcome.message);
    const shared = state => ({ ...state, tagcountConsistent: undefined });
    expect(shared(ui.state)).toEqual(shared(php.state));
    expect(shared(api.state)).toEqual(shared(php.state));
    expect(ui.emails).toEqual(php.emails);
    expect(api.emails).toEqual(php.emails);
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

  describe('admin pages', () => {
    test('an admin approves a queued question on the moderation page', async () => {
      await withOptions({ moderate_users: '1', moderate_unapproved: '1' }, async () => {
        for (const b of backends) {
          await b.pool.execute('UPDATE qa_users SET level=0 WHERE userid=?', [b.users.target]);
          const outcome = await b.target.ask({ title: `Queued ${b.token} for the moderation page`, content: 'Please approve this question.', tags: 'admin' });
          b.ids.qm = outcome.id;
        }
      });
      const { php } = await runEverywhere(b => b.actor.adminClick('moderate', b.ids.qm, 'approve'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.qm).toMatchObject({ type: 'Q' });
    });
    test('an admin clears flags on the flagged page', async () => {
      // The page lists only the 50 most-flagged posts, and the test databases keep flagged posts from
      // earlier runs, so this one is given many more flags to stay at the top of the list.
      for (const b of backends) {
        await b.target.act(b.ids.qp, b.ids.qp, 'Q', 'flag');
        await b.pool.execute('UPDATE qa_posts SET flagcount=flagcount+200 WHERE postid=?', [b.ids.qp]);
      }
      const { php } = await runEverywhere(b => b.actor.adminClick('flagged', b.ids.qp, 'clearflags'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.qp).toMatchObject({ flagcount: 0 });
    });
    test('an admin reshows a hidden answer on the hidden page', async () => {
      for (const b of backends) await b.actor.act(b.ids.qp, b.ids.ap, 'A', 'hide');
      const { php } = await runEverywhere(b => b.actor.adminClick('hidden', b.ids.ap, 'reshow'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.ap).toMatchObject({ type: 'A' });
    });
    test('an admin deletes a hidden question with no answers on the hidden page', async () => {
      for (const b of backends) await b.actor.act(b.ids.qm, b.ids.qm, 'Q', 'hide');
      const { php } = await runEverywhere(b => b.actor.adminClick('hidden', b.ids.qm, 'delete'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.qm).toBeUndefined();
    });
  });

  describe('users', () => {
    test('an admin approves a new user from their profile, and the user is emailed', async () => {
      const { php } = await withOptions({ moderate_users: '1' }, () => runEverywhere(b => b.actor.userButton(b.handles.target, 'doapprove')));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.users.target).toMatchObject({ level: 10 });
      expect(php.state.uapprovecountConsistent).toBe(true);
      expect(php.emails).toHaveLength(1);
    });
    test('a moderator approves a user from the approve-users page', async () => {
      const { php } = await withOptions({ moderate_users: '1' }, () => runEverywhere(b => b.other.adminClick('approve', b.users.voter, 'userapprove', b.handles.voter)));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.users.voter).toMatchObject({ level: 10 });
    });
    test('an admin blocks a user', async () => {
      const { php } = await runEverywhere(b => b.actor.userButton(b.handles.target, 'doblock'));
      expect(php.state.users.target.flags & 2).toBe(2);
    });
    test('and unblocks them', async () => {
      const { php } = await runEverywhere(b => b.actor.userButton(b.handles.target, 'dounblock'));
      expect(php.state.users.target.flags & 2).toBe(0);
    });
    test('an admin edits a user\'s email, profile and level', async () => {
      const { php } = await runEverywhere(b => b.actor.adminEditUser(b.handles.target, { email: `edited${b.mark}@example.test`, profile: { name: '', location: 'Montreal', website: '', about: '' }, level: 20 }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.users.target).toMatchObject({ email: 'edited<b>@example.test', level: 20 });
      expect(php.state.users.target.profile).toContain('location=Montreal');
    });
    test('a moderator can promote a user only up to expert', async () => {
      const { php } = await runEverywhere(b => b.other.adminEditUser(b.handles.voter, { level: 50 }));
      expect(php.state.users.voter).toMatchObject({ level: 20 });
    });
    test('a moderator cannot delete a user', async () => {
      for (const b of backends) await b.actor.userButton(b.handles.voter, 'doblock');
      const { php, api } = await runEverywhere(b => b.other.userButton(b.handles.voter, 'dodelete'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'delete_not_allowed' });
    });
    test('an admin deletes a user; the flags they gave are recounted', async () => {
      // The voter flagged a question before being blocked (blocked users cannot flag).
      for (const b of backends) await b.pool.execute('UPDATE qa_users SET flags=flags&~2 WHERE userid=?', [b.users.voter]);
      for (const b of backends) await b.voter.act(b.ids.qp, b.ids.qp, 'Q', 'flag');
      for (const b of backends) await b.pool.execute('UPDATE qa_users SET flags=flags|2 WHERE userid=?', [b.users.voter]);
      const { php } = await runEverywhere(b => b.actor.userButton(b.handles.voter, 'dodelete'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.users.voter).toBeNull();
      expect(php.state.posts.qp).toMatchObject({ flagcount: 0 });
    });
    test('an admin hides all of a user\'s posts', async () => {
      for (const b of backends) await b.actor.userButton(b.handles.owner, 'doblock');
      const { php } = await runEverywhere(b => b.actor.userButton(b.handles.owner, 'dohideall'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.qp).toMatchObject({ type: 'Q_HIDDEN' });
      expect(php.state.posts.ap).toMatchObject({ type: 'A_HIDDEN' });
    });
  });
});
