// Post-change parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each
// edit, retag, remoderate and convert identical posts. Outcomes, page messages and every value
// app/post-update.php writes (post fields, the editor's record, the word index, cached counts,
// points, update streams) must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable } = require('./post-helpers');
const visitorFor = b => (b.tag === 'n' ? apiDriver(b.actor.pool) : siteDriver(b.actor.name, b.tag === 'p' ? PHP_URL : UI_URL, b.actor.pool));

describe('PHP ↔ Node post-change parity (original pages, shared UI bridge and API)', () => {
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
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `e${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const token = `tok${tag}${suffix}`;
      const { ids, users } = await createFixtures(drivers.actor.pool, handles, token);
      // The actor's own posts, created through each backend's own create path.
      const made = async promise => { const outcome = await promise; if (!outcome.accepted) throw new Error(`${tag}: fixture post rejected`); return outcome.id; };
      ids.qx = await made(drivers.actor.ask({ title: `Caching ${token} strategy for reports`, content: 'Should I cache the whole page or only the query results?', tags: 'alpha beta', notify: true }));
      ids.ax = await made(drivers.actor.answer(ids.q, { content: `Cache the rendered fragment for ${token} pages.`, notify: true }));
      ids.cx = await made(drivers.actor.comment(ids.qa, ids.a, { content: 'Would this also work with MyISAM tables?' }));
      ids.ax2 = await made(drivers.actor.answer(ids.qa, { content: 'Partial indexes are not supported in MySQL though.' }));
      // A question of the actor's with answers from two other users, for selecting and closing.
      ids.qs = await made(drivers.actor.ask({ title: `Choosing ${token} a message queue`, content: 'RabbitMQ or Kafka for a small team?', tags: 'queue' }));
      ids.as1 = await made(drivers.owner.answer(ids.qs, { content: 'RabbitMQ is simpler to run for a small team.' }));
      ids.as2 = await made(drivers.other.answer(ids.qs, { content: 'Kafka if you need to replay old events later.' }));
      // Closing gets its own question: Q2A keeps 5 update events per question and trims by timestamp,
      // so a longer sequence on one question would depend on which events share a second.
      ids.qc = await made(drivers.actor.ask({ title: `Hosting ${token} a static site`, content: 'Which host is cheapest for a static site?', tags: 'hosting' }));
      backends.push({ ...drivers, handles, ids, users, token, tag });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

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
  const setLevel = (label, level) => Promise.all(backends.map(b => b.actor.pool.execute('UPDATE qa_users SET level=? WHERE userid=?', [level, b.users[label]])));

  describe('editing', () => {
    test('the author edits the title, content and tags of a question', async () => {
      const { php } = await runEverywhere(b => b.actor.edit(b.ids.qx, b.ids.qx, 'Q', {
        title: `Caching ${b.token} strategy for slow reports`, content: 'Should I cache whole pages, fragments or query results?', tags: 'alpha gamma',
      }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.posts.qx).toMatchObject({ updatetype: 'E', lastuserid: 'actor', hasupdated: 1, tags: 'alpha,gamma' });
      expect(php.state.tagcountConsistent).toBe(true);
    });
    test('the author changes only the tags', async () => {
      const { php } = await runEverywhere(b => b.actor.edit(b.ids.qx, b.ids.qx, 'Q', { tags: 'alpha delta' }));
      expect(php.state.posts.qx).toMatchObject({ updatetype: 'T', tags: 'alpha,delta' });
    });
    test('saving without changes records nothing new', async () => {
      const { php } = await runEverywhere(b => b.actor.edit(b.ids.qx, b.ids.qx, 'Q', {}));
      expect(php.outcome.accepted).toBe(true);
    });
    test('rejects a title that is too short', async () => {
      const { php, api } = await runEverywhere(b => b.actor.edit(b.ids.qx, b.ids.qx, 'Q', { title: 'Too short' }));
      expect(php.outcome.message).toBe('Please provide more information - at least 12 characters');
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { title: 'min_length' } });
    });
    test("other users cannot edit someone else's question", async () => {
      const { php, api } = await runEverywhere(b => b.other.edit(b.ids.qx, b.ids.qx, 'Q', { title: `Edited by someone ${b.token} else` }));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'edit_not_allowed' });
    });
    test("an editor edits someone else's question", async () => {
      await setLevel('other', 50);
      try {
        const { php } = await runEverywhere(b => b.other.edit(b.ids.qx, b.ids.qx, 'Q', { content: 'Edited by an editor for clarity and grammar.' }));
        expect(php.state.posts.qx).toMatchObject({ lastuserid: 'other', updatetype: 'E' });
      } finally { await setLevel('other', 0); }
    });
    test('the author edits an answer', async () => {
      const { php } = await runEverywhere(b => b.actor.edit(b.ids.q, b.ids.ax, 'A', { content: `Cache the rendered fragment for ${b.token} pages, keyed by user.` }));
      expect(php.state.posts.ax).toMatchObject({ updatetype: 'E', lastuserid: 'actor' });
    });
    test('the author edits a comment', async () => {
      const { php } = await runEverywhere(b => b.actor.edit(b.ids.qa, b.ids.cx, 'C', { content: 'Would this also work with InnoDB tables?' }));
      expect(php.state.posts.cx).toMatchObject({ updatetype: 'E' });
    });
    test('rejects an answer edit that is too short', async () => {
      const { php, api } = await runEverywhere(b => b.actor.edit(b.ids.q, b.ids.ax, 'A', { content: 'Short' }));
      expect(php.outcome.message).toBe('Please provide more information - at least 12 characters');
      expect(api.outcome).toMatchObject({ status: 400, fields: { content: 'min_length' } });
    });
    test('the author turns an answer into a comment on another answer', async () => {
      const { php } = await runEverywhere(b => b.actor.edit(b.ids.qa, b.ids.ax2, 'A', { dotoc: true, commenton: b.ids.a }));
      expect(php.state.posts.ax2).toMatchObject({ type: 'C', parentid: 'a', updatetype: 'Y' });
      expect(php.state.posts.qa).toMatchObject({ acount: 1 });
      expect(php.state.caches).toMatchObject({ cache_acount: -1, cache_ccount: 1 });
      expect(php.state.limits.C).toEqual([1, 1]);
    });
    test('an edit goes back to the moderation queue when edits are moderated', async () => {
      const { php } = await withOptions({ moderate_edited_again: '1', moderate_users: '1', moderate_unapproved: '1' }, () =>
        runEverywhere(b => b.actor.edit(b.ids.qx, b.ids.qx, 'Q', { content: 'Rewritten after review: which cache layer is best?' })));
      expect(php.state.posts.qx).toMatchObject({ type: 'Q_QUEUED' });
      expect(php.state.caches).toMatchObject({ cache_queuedcount: 1, cache_qcount: -1 });
      expect(php.state.index.title).toEqual([]);
    });
  });

  describe('selecting the best answer', () => {
    test('the asker selects an answer', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.qs, b.ids.as1, 'A', 'select'));
      expect(php.state.posts.qs).toMatchObject({ selchildid: 'as1' });
      expect(php.state.posts.as1).toMatchObject({ updatetype: 'S', lastuserid: 'actor' });
      expect(php.state.caches).toMatchObject({ cache_unselqcount: -1 });
    });
    test('the asker moves the selection to another answer', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.qs, b.ids.as2, 'A', 'select'));
      expect(php.state.posts.qs).toMatchObject({ selchildid: 'as2' });
      expect(php.state.posts.as1).toMatchObject({ updatetype: null });
    });
    test('the asker removes the selection', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.qs, b.ids.as2, 'A', 'unselect'));
      expect(php.state.posts.qs).toMatchObject({ selchildid: null });
    });
    test('other users cannot select an answer', async () => {
      const { php, api } = await runEverywhere(b => b.owner.act(b.ids.qs, b.ids.as1, 'A', 'select'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'select_not_allowed' });
    });
  });

  describe('closing and reopening', () => {
    test('the asker closes their question with a note', async () => {
      const { php } = await runEverywhere(b => b.actor.close(b.ids.qc, 'Solved in our team chat.'));
      expect(php.state.posts.qc).toMatchObject({ closedbyid: 'note:qc', updatetype: 'C' });
      expect(php.state.posts['note:qc']).toMatchObject({ type: 'NOTE', content: 'Solved in our team chat.' });
    });
    test('the asker reopens it, removing the note', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.qc, b.ids.qc, 'Q', 'reopen'));
      expect(php.state.posts.qc).toMatchObject({ closedbyid: null });
      expect(php.state.posts['note:qc']).toBeUndefined();
    });
    test('the asker closes it as a duplicate of another question', async () => {
      const { php } = await runEverywhere(b => b.actor.close(b.ids.qc, `http://localhost/index.php?qa=${b.ids.q}`));
      expect(php.state.posts.qc).toMatchObject({ closedbyid: 'q' });
    });
    test('the asker reopens the duplicate', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.qc, b.ids.qc, 'Q', 'reopen'));
      expect(php.state.posts.qc).toMatchObject({ closedbyid: null });
    });
    test('a closing link that names no other question is rejected', async () => {
      const { php, api } = await runEverywhere(b => b.actor.close(b.ids.qc, 'http://localhost/no-question-here'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, fields: { details: 'duplicate_not_found' } });
    });

  });

  describe('hiding, moderation, deleting and claiming', () => {
    test('the author hides their answer', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.ax, 'A', 'hide'));
      expect(php.state.posts.ax).toMatchObject({ type: 'A_HIDDEN', updatetype: 'H' });
      expect(php.state.caches).toMatchObject({ cache_acount: -1 });
    });
    test('the author shows it again', async () => {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.ax, 'A', 'reshow'));
      expect(php.state.posts.ax).toMatchObject({ type: 'A' });
    });
    test('users cannot delete their own hidden answer without the permission', async () => {
      await runEverywhere(b => b.actor.act(b.ids.q, b.ids.ax, 'A', 'hide'));
      const { php, api } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.ax, 'A', 'delete'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 403, code: 'delete_not_allowed' });
    });
    describe('as a moderator', () => {
      beforeAll(() => setLevel('other', 80));
      afterAll(() => setLevel('other', 0));
      test('a moderator deletes a hidden answer', async () => {
        const { php } = await runEverywhere(b => b.other.act(b.ids.q, b.ids.ax, 'A', 'delete'));
        expect(php.state.posts.ax).toBeUndefined();
        expect(php.state.points.actor).toBeTruthy();
      });
      // pages/question.php gives the question's rules its duplicates too ($childposts + $duplicateposts).
      test('a hidden question that another question is closed as a duplicate of cannot be deleted', async () => {
        for (const b of backends) {
          b.ids.qd = (await b.actor.ask({ title: `Original ${b.token} question about sorting`, content: 'How do I sort a list in place?', tags: 'sort' })).id;
          b.ids.qdup = (await b.actor.ask({ title: `Duplicate ${b.token} question on sorting lists`, content: 'Is there a way to sort lists?', tags: 'sort' })).id;
          const closed = await b.actor.close(b.ids.qdup, `http://localhost/index.php?qa=${b.ids.qd}`);
          if (!closed.accepted) throw new Error(`${b.tag}: could not close the duplicate`);
        }
        await runEverywhere(b => b.other.act(b.ids.qd, b.ids.qd, 'Q', 'hide'));
        const { php, api } = await runEverywhere(b => b.other.act(b.ids.qd, b.ids.qd, 'Q', 'delete'));
        expect(php.outcome.accepted).toBe(false);
        expect(api.outcome).toMatchObject({ status: 403, code: 'delete_not_allowed' });
      });
      test("a moderator hides someone's comment", async () => {
        const { php } = await runEverywhere(b => b.other.act(b.ids.qa, b.ids.cx, 'C', 'hide'));
        expect(php.state.posts.cx).toMatchObject({ type: 'C_HIDDEN', lastuserid: 'other' });
      });
      test('a moderator approves an edit that went back to the queue', async () => {
        const { php } = await runEverywhere(b => b.other.act(b.ids.qx, b.ids.qx, 'Q', 'approve'));
        expect(php.state.posts.qx).toMatchObject({ type: 'Q' });
        expect(php.state.caches).toMatchObject({ cache_queuedcount: -1, cache_qcount: 1 });
      });
      test('a moderator approves a new queued question', async () => {
        await withOptions({ moderate_users: '1', moderate_unapproved: '1' }, async () => {
          for (const b of backends) {
            const outcome = await b.actor.ask({ title: `Queued ${b.token} question to approve`, content: 'Waiting for approval.', tags: 'queue' });
            b.ids.qq = outcome.id;
          }
        });
        const { php } = await runEverywhere(b => b.other.act(b.ids.qq, b.ids.qq, 'Q', 'approve'));
        expect(php.state.posts.qq).toMatchObject({ type: 'Q' });
        expect(php.state.events.shared.length).toBeGreaterThan(0);
      });
      test('a moderator rejects a queued question', async () => {
        await withOptions({ moderate_users: '1', moderate_unapproved: '1' }, async () => {
          for (const b of backends) {
            const outcome = await b.actor.ask({ title: `Queued ${b.token} question to reject`, content: 'Waiting for review.', tags: 'queue' });
            b.ids.qr = outcome.id;
          }
        });
        const { php } = await runEverywhere(b => b.other.act(b.ids.qr, b.ids.qr, 'Q', 'reject'));
        expect(php.state.posts.qr).toMatchObject({ type: 'Q_HIDDEN' });
      });
    });
    test('a visitor claims their anonymous answer after registering', async () => {
      const visitors = new Map();
      for (const b of backends) {
        // Its own question: qs already holds more than the 5 events Q2A keeps per question, and
        // which ones survive trimming depends on second boundaries, on any backend.
        b.ids.qv = (await b.actor.ask({ title: `Claiming ${b.token} an answer later`, content: 'Can I claim what I posted before signing up?', tags: 'queue' })).id;
        const visitor = visitorFor(b);
        const outcome = await visitor.answer(b.ids.qv, { content: 'Posted before I had an account here.' });
        b.ids.anon = outcome.id;
        await visitor.register(`ev${b.tag}${suffix}`);
        const [[row]] = await b.actor.pool.execute('SELECT userid FROM qa_users WHERE handle=?', [`ev${b.tag}${suffix}`]);
        b.users.visitor = row.userid;
        visitors.set(b.tag, visitor);
      }
      const { php } = await runEverywhere(b => visitors.get(b.tag).act(b.ids.qv, b.ids.anon, 'A', 'claim'));
      expect(php.state.posts.anon).toMatchObject({ userid: 'visitor' });
      expect(php.state.points.visitor).toMatchObject({ aposts: 1 });
    });
  });
});
