// Notification parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each
// do the things that make Q2A send email (registering, asking, answering, commenting, following,
// selecting, moderating, flagging, wall posts, private messages, feedback). Every email caught by
// Mailpit during each step (recipients, subject, sender, reply-to and text) must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, emailsDuring } = require('./post-helpers');

const ADMIN = 'admin@example.test';
const SUITE_OPTIONS = { feedback_email: ADMIN, notify_admin_q_post: '1', moderate_notify_admin: '1', register_notify_admin: '1', comment_on_qs: '1' };

describe('PHP ↔ Node notification parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;
  const saved = [];

  const setOptions = async values => {
    for (const pool of [phpPool, nodePool]) {
      const old = {};
      for (const [title, content] of Object.entries(values)) {
        const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [title]);
        old[title] = row?.content;
        await pool.execute('INSERT INTO qa_options (title,content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [title, content]);
      }
      saved.push([pool, old]);
    }
    return saved.length;
  };
  const restoreOptions = async count => {
    while (saved.length > count - 2) {
      const [pool, old] = saved.pop();
      for (const [title, content] of Object.entries(old)) {
        if (content === undefined) await pool.execute('DELETE FROM qa_options WHERE title=?', [title]);
        else await pool.execute('UPDATE qa_options SET content=? WHERE title=?', [content, title]);
      }
    }
  };
  const withOptions = async (values, work) => {
    const mark = await setOptions(values);
    try { return await work(); } finally { await restoreOptions(mark); }
  };

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action IN ('Q','A','C','F','M','W')");
    await setOptions(SUITE_OPTIONS);
    backends = [];
    for (const [tag, pool, make] of [
      ['p', phpPool, () => siteDriver('php', PHP_URL, phpPool)],
      ['u', nodePool, () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', nodePool, () => apiDriver(nodePool)],
    ]) {
      const drivers = { owner: make(), actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `n${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const users = {};
      for (const [label, handle] of Object.entries(handles)) {
        const [[row]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [handle]);
        users[label] = row.userid;
      }
      backends.push({ ...drivers, pool, handles, users, ids: {}, tag, make, mark: `${tag}${suffix}` });
    }
  });
  afterAll(async () => {
    await restoreOptions(2);
    await Promise.all([phpPool.end(), nodePool.end()]);
  });

  // The emails, with each backend's users, tokens and post IDs replaced by labels.
  function normalize(b, emails) {
    const labels = new Map(Object.entries(b.ids).map(([label, id]) => [String(id), label]));
    const clean = value => String(value ?? '')
      .split(b.mark).join('<b>')
      .replace(/(qa=|show=|#[aqc])(\d+)/g, (match, prefix, id) => `${prefix}${labels.get(id) ?? 'other'}`)
      .replace(/[0-9a-z]{8}(?=\n)/g, code => (/\d/.test(code) && /[a-z]/.test(code) ? '<code>' : code));
    const addresses = list => (list ?? []).map(a => ({ name: clean(a.Name), address: clean(a.Address) }));
    return emails.map(email => JSON.stringify({
      to: addresses(email.to), from: addresses([email.from].filter(Boolean)), replyTo: addresses(email.replyTo), subject: clean(email.subject), text: clean(email.text),
    })).sort();
  }
  async function runEverywhere(perform) {
    const results = [];
    for (const b of backends) {
      const { outcome, emails } = await emailsDuring(() => perform(b));
      if (outcome.id) b.lastId = outcome.id;
      results.push({ outcome, emails: normalize(b, emails) });
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.emails).toEqual(php.emails);
    expect(api.emails).toEqual(php.emails);
    return { php: { ...php, emails: php.emails.map(e => JSON.parse(e)) } };
  }
  const remember = label => { for (const b of backends) b.ids[label] = b.lastId; };
  const to = (php, address) => php.emails.filter(e => e.to.some(t => t.address === address));
  const setLevel = (label, level) => Promise.all(backends.map(b => b.pool.execute('UPDATE qa_users SET level=? WHERE userid=?', [level, b.users[label]])));

  test('registering sends the welcome email and tells the admin', async () => {
    const { php } = await runEverywhere(async b => { await b.make().register(`nnew${b.mark}`); return { accepted: true }; });
    expect(to(php, 'nnew<b>@example.test')[0].subject).toBe('Welcome to Question2Answer Q&A!');
    expect(to(php, ADMIN)).toHaveLength(1);
  });
  test('a new question is sent to the admin', async () => {
    const { php } = await runEverywhere(b => b.owner.ask({ title: `Notifying ${b.mark} about a new question`, content: 'Who gets an email when I ask?', tags: 'mail', notify: true }));
    remember('q');
    expect(to(php, ADMIN)[0].subject).toContain('has a new question');
  });
  test('an answer is sent to the question\'s author', async () => {
    const { php } = await runEverywhere(b => b.actor.answer(b.ids.q, { content: `The author ${b.mark} gets an email.`, notify: true }));
    remember('a');
    expect(to(php, 'nowner<b>@example.test')).toHaveLength(1);
    expect(to(php, 'nowner<b>@example.test')[0].text).toContain('#a');
  });
  test('a comment is sent to the answer\'s author', async () => {
    const { php } = await runEverywhere(b => b.other.comment(b.ids.q, b.ids.a, { content: `A first comment from ${b.mark}.`, notify: true }));
    remember('c1');
    expect(to(php, 'nactor<b>@example.test')).toHaveLength(1);
  });
  test('a later comment is sent to the answer\'s author and earlier commenters, once each', async () => {
    const { php } = await runEverywhere(b => b.owner.comment(b.ids.q, b.ids.a, { content: `A second comment from ${b.mark}.`, notify: true }));
    remember('c2');
    expect(to(php, 'nactor<b>@example.test')).toHaveLength(1);
    expect(to(php, 'nother<b>@example.test')).toHaveLength(1);
  });
  test('selecting the best answer tells its author', async () => {
    const { php } = await runEverywhere(b => b.owner.act(b.ids.q, b.ids.a, 'A', 'select'));
    expect(to(php, 'nactor<b>@example.test')[0].subject).toContain('selected');
  });
  // Q2A 1.8.8 reports the followed answer as 'parent' while qa_event_notify reads 'followanswer',
  // so only the admin hears about it; Node matches that.
  test('a question that follows an answer is only sent to the admin', async () => {
    const { php } = await runEverywhere(b => b.other.ask({ title: `Following ${b.mark} an answer with a question`, content: 'This builds on the answer above.', tags: 'mail', followAnswerId: b.ids.a }));
    remember('qf');
    expect(to(php, 'nactor<b>@example.test')).toHaveLength(0);
    expect(to(php, ADMIN)).toHaveLength(1);
  });
  test('a post that waits for moderation is sent to the admin, and its approval to the question\'s author', async () => {
    await withOptions({ moderate_users: '1', moderate_unapproved: '1' }, async () => {
      const queued = await runEverywhere(b => b.other.answer(b.ids.q, { content: `A queued ${b.mark} answer.` }));
      remember('aq');
      expect(to(queued.php, ADMIN)[0].subject).toContain('moderation');
    });
    await setLevel('actor', 80);
    try {
      const { php } = await runEverywhere(b => b.actor.act(b.ids.q, b.ids.aq, 'A', 'approve'));
      expect(to(php, 'nowner<b>@example.test')).toHaveLength(1);
    } finally { await setLevel('actor', 0); }
  });
  test('a flag is sent to the admin', async () => {
    const { php } = await runEverywhere(b => b.actor.act(b.ids.qf, b.ids.qf, 'Q', 'flag'));
    expect(php.outcome).toMatchObject({ accepted: true });
    expect(to(php, ADMIN)[0].subject).toContain('flagged');
  });
  test('a wall post is sent to the wall\'s owner', async () => {
    const { php } = await runEverywhere(b => b.actor.wallPost(b.handles.owner, `Hello ${b.mark} on your wall.`));
    expect(to(php, 'nowner<b>@example.test')[0].subject).toContain('wall');
  });
  test('a private message is emailed to its recipient', async () => {
    const { php } = await runEverywhere(b => b.actor.sendMessage(b.handles.owner, `A private ${b.mark} note.`));
    expect(to(php, 'nowner<b>@example.test')[0].text).toContain('A private <b> note.');
  });
  test('feedback is emailed to the site\'s feedback address', async () => {
    const { php } = await runEverywhere(b => b.make().feedback({ message: `Feedback ${b.mark} about the site.`, name: 'Visitor', email: 'visitor@example.test' }));
    expect(php.outcome.accepted).toBe(true);
    expect(to(php, ADMIN)[0]).toMatchObject({ replyTo: [{ name: 'Visitor', address: 'visitor@example.test' }] });
  });
});
