// Random differential testing: a seeded random sequence of mixed user actions runs in lockstep on the
// original PHP site and the shared UI (which sends every write and read to Node), starting from the same
// fresh databases (scripts/fresh-databases.sh). After every action both sites must answer the same way;
// every few actions, and at the end, every Q2A table must hold the same rows (tests/reliability/db-state.js);
// at the end the invariants must hold and every kind of page must render the same HTML for the same viewer.
//
//   scripts/reliability.sh                      (resets the databases, then runs the reliability suites)
//   FUZZ_SEED=1234 FUZZ_STEPS=300 scripts/reliability.sh differential
//
// A failure prints the seed and the actions so far, so the same run can be replayed exactly.
const request = require('supertest');
const cheerio = require('cheerio');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver } = require('../parity/post-helpers');
const { trimEventStreams, setOptions, alignSeedTimes, databaseState, diffStates, checkInvariants, onlyInNode, optionsOnlyOnOneSide } = require('./db-state');

const run = process.env.RELIABILITY === '1' ? describe : describe.skip;
jest.setTimeout(60 * 60 * 1000); // a long run takes minutes
const SEED = Number(process.env.FUZZ_SEED || Math.floor(Math.random() * 2 ** 31));
const STEPS = Number(process.env.FUZZ_STEPS || 150);
const DIFF_EVERY = Number(process.env.FUZZ_DIFF_EVERY || 10);

// mulberry32: small, fast and reproducible.
function random(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = n => Math.floor(next() * n);
  const pick = list => list[int(list.length)];
  const chance = p => next() < p;
  return { next, int, pick, chance };
}

// Text that exercises escaping, word splitting and encodings: quotes, markup, accents, emoji, long words.
const WORDS = ['cache', 'index', 'query', 'Node', 'PHP', 'docker', 'café', 'naïve', 'über', 'тест', '数据库', 'emoji🙂', 'quote\'s', '"double"',
  '<b>bold</b>', 'a&b', '100%', 'snake_case', 'back\\slash', 'semi;colon', 'tab\there', 'longwordlongwordlongwordlongword', 'x', 'C++', 'C#'];
const TAGS = ['mysql', 'php', 'nodejs', 'docker', 'security', 'cache', 'jwt', 'testing', 'q2a', 'unicode'];
function sentence(rng, min, max, words = WORDS) {
  const n = min + rng.int(max - min + 1);
  return Array.from({ length: n }, () => rng.pick(words)).join(' ');
}
// Characters outside the Basic Multilingual Plane (emoji) crash PHP's message and wall pages (MySQL refuses
// them in the utf8mb3 columns) while Node drops them, a known difference (known-differences.test.js), so
// messages use the other words.
const BMP_WORDS = WORDS.filter(word => [...word].every(c => c.codePointAt(0) <= 0xffff));

run('Random differential runs: PHP site ↔ shared UI on identical databases', () => {
  let phpPool, nodePool, rng, sites, log, restoreOptions;
  const handles = ['fzadmin', 'fzalice', 'fzbob', 'fzcarol', 'fzdave'];

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    rng = random(SEED);
    log = [];
    // Identical starting points: the databases must already be the same fresh seed.
    const start = diffStates(await databaseState(phpPool), await databaseState(nodePool));
    if (start.length) throw new Error(`The databases differ before the run (run scripts/fresh-databases.sh first): ${JSON.stringify(start[0])}`);
    // The same times for the seed on both sides (Q2A trims event streams by time; see db-state.js).
    for (const pool of [phpPool, nodePool]) await alignSeedTimes(pool);
    // Rate limits out of the way (the slice suites test them), put back afterwards.
    const LIMITS = ['max_rate_ip_qs', 'max_rate_ip_as', 'max_rate_ip_cs', 'max_rate_ip_votes', 'max_rate_ip_flags', 'max_rate_ip_messages', 'max_rate_ip_uploads', 'max_rate_ip_logins', 'max_rate_ip_registers',
      'max_rate_user_qs', 'max_rate_user_as', 'max_rate_user_cs', 'max_rate_user_votes', 'max_rate_user_flags', 'max_rate_user_messages', 'max_rate_user_uploads'];
    restoreOptions = await setOptions([phpPool, nodePool], Object.fromEntries(LIMITS.map(name => [name, '100000'])));
    // The same users, registered in the same order on both sites; the first is an administrator.
    sites = { php: { pool: phpPool, url: PHP_URL, users: {} }, ui: { pool: nodePool, url: UI_URL, users: {} } };
    for (const handle of handles) {
      for (const site of Object.values(sites)) {
        site.users[handle] = siteDriver(site === sites.php ? 'php' : 'migrated-ui', site.url, site.pool);
        await site.users[handle].register(handle);
      }
    }
    for (const pool of [phpPool, nodePool]) await pool.query("UPDATE qa_users SET level=120 WHERE handle='fzadmin'");
    for (const site of Object.values(sites)) site.anonymous = siteDriver('anonymous', site.url, site.pool);
  });
  afterAll(async () => { if (restoreOptions) await restoreOptions(); await Promise.all([phpPool?.end(), nodePool?.end()]); });

  // The reference state for choosing targets: PHP's rows (the two must be equal anyway).
  async function world() {
    const [posts] = await phpPool.query("SELECT postid, type, parentid, userid, closedbyid, selchildid, flagcount FROM qa_posts WHERE type IN ('Q','A','C','Q_HIDDEN','A_HIDDEN','C_HIDDEN') ORDER BY postid");
    const [users] = await phpPool.query('SELECT userid, handle FROM qa_users ORDER BY userid');
    const [tags] = await phpPool.query('SELECT word FROM qa_words WHERE tagcount>0 ORDER BY word');
    const byId = new Map(posts.map(p => [p.postid, p]));
    const questionOf = post => (post.type.startsWith('Q') ? post.postid : post.type.startsWith('A') ? post.parentid : questionOf(byId.get(post.parentid) ?? post));
    return { posts, users, tags: tags.map(t => t.word), byId, questionOf };
  }
  const visible = (w, prefix) => w.posts.filter(p => p.type === prefix);
  // The run's own user with that ID (seeded users such as alice have no driver here).
  const userFor = (w, userid) => { const handle = w.users.find(u => String(u.userid) === String(userid))?.handle; return handles.includes(handle) ? handle : null; };

  // The site's vote: ajax/vote.php with the user's security code from a question page.
  async function vote(driver, questionid, postid, value) {
    const client = driver._client;
    const page = await client.get(`/index.php?qa=${questionid}`).redirects(3);
    const code = cheerio.load(page.text)('[name^="vote_"]').first().closest('form').find('[name=code]').val() || 'none';
    const response = await client.post('/index.php').type('form').send({ qa: 'ajax', qa_operation: 'vote', qa_root: './', qa_request: String(questionid), postid: String(postid), vote: String(value), code });
    const lines = response.text.slice(response.text.indexOf('QA_AJAX_RESPONSE')).split('\n');
    return { accepted: lines[1] === '1', message: cheerio.load(lines.slice(2).join('\n')).text().replace(/\s+/g, ' ').trim() };
  }

  // Each action: [weight, name, plan(world) → { who, args } or null, perform(driver, args)].
  const ACTIONS = [
    [8, 'ask', w => ({ who: rng.chance(0.15) ? 'anonymous' : rng.pick(handles), args: {
      title: rng.chance(0.08) ? 'short' : sentence(rng, 3, 9), content: rng.chance(0.05) ? '' : sentence(rng, 4, 30),
      tags: Array.from({ length: rng.int(4) }, () => rng.pick(TAGS)).join(' '), notify: rng.chance(0.3) } }),
      (d, a) => d.ask(a)],
    [10, 'answer', w => { const q = rng.pick(visible(w, 'Q')); return q && { who: rng.chance(0.1) ? 'anonymous' : rng.pick(handles), args: { q: q.postid, content: rng.chance(0.05) ? 'no' : sentence(rng, 3, 25) } }; },
      (d, a) => d.answer(a.q, { content: a.content })],
    [8, 'comment', w => { const p = rng.pick([...visible(w, 'Q'), ...visible(w, 'A')]); return p && { who: rng.pick(handles), args: { q: w.questionOf(p), parent: p.postid, content: sentence(rng, 2, 15) } }; },
      (d, a) => d.comment(a.q, a.parent, { content: a.content })],
    [14, 'vote', w => { const p = rng.pick([...visible(w, 'Q'), ...visible(w, 'A')]); return p && { who: rng.pick(handles), args: { q: w.questionOf(p), post: p.postid, value: rng.pick([1, 1, -1, 0]) } }; },
      (d, a) => vote(d, a.q, a.post, a.value)],
    [5, 'flag', w => { const p = rng.pick([...visible(w, 'Q'), ...visible(w, 'A'), ...visible(w, 'C')]); return p && { who: rng.pick(handles), args: { q: w.questionOf(p), post: p.postid, kind: p.type[0], action: rng.pick(['flag', 'flag', 'unflag']) } }; },
      (d, a) => d.act(a.q, a.post, a.kind, a.action)],
    [4, 'select answer', w => { const a = rng.pick(visible(w, 'A')); if (!a) return null; const q = w.byId.get(a.parentid); return q && { who: rng.chance(0.8) ? userFor(w, q.userid) ?? 'fzadmin' : rng.pick(handles), args: { q: q.postid, post: a.postid, action: q.selchildid === a.postid ? 'unselect' : 'select' } }; },
      (d, a) => d.act(a.q, a.post, 'A', a.action)],
    [3, 'close or reopen', w => { const q = rng.pick(visible(w, 'Q')); return q && { who: rng.chance(0.7) ? 'fzadmin' : userFor(w, q.userid) ?? 'fzbob', args: { q: q.postid, reopen: q.closedbyid !== null, details: sentence(rng, 2, 8) } }; },
      (d, a) => (a.reopen ? d.act(a.q, a.q, 'Q', 'reopen') : d.close(a.q, a.details))],
    [5, 'edit question', w => { const q = rng.pick(visible(w, 'Q')); return q && { who: rng.chance(0.7) ? userFor(w, q.userid) ?? 'fzadmin' : rng.pick(handles), args: { q: q.postid,
      changes: { title: rng.chance(0.5) ? sentence(rng, 3, 9) : undefined, content: rng.chance(0.5) ? sentence(rng, 4, 20) : undefined, tags: rng.chance(0.5) ? Array.from({ length: rng.int(4) }, () => rng.pick(TAGS)).join(' ') : undefined } } }; },
      (d, a) => d.edit(a.q, a.q, 'Q', Object.fromEntries(Object.entries(a.changes).filter(([, v]) => v !== undefined)))],
    [4, 'edit answer', w => { const p = rng.pick(visible(w, 'A')); return p && { who: rng.chance(0.7) ? userFor(w, p.userid) ?? 'fzadmin' : rng.pick(handles), args: { q: p.parentid, post: p.postid, content: sentence(rng, 3, 20) } }; },
      (d, a) => d.edit(a.q, a.post, 'A', { content: a.content })],
    [4, 'hide or reshow', w => { const p = rng.pick(w.posts); return p && { who: rng.chance(0.7) ? 'fzadmin' : userFor(w, p.userid) ?? 'fzcarol', args: { q: w.questionOf(p), post: p.postid, kind: p.type[0], action: p.type.endsWith('_HIDDEN') ? rng.pick(['reshow', 'reshow', 'delete']) : 'hide' } }; },
      (d, a) => d.act(a.q, a.post, a.kind, a.action)],
    [3, 'favorite question', w => { const q = rng.pick(visible(w, 'Q')); return q && { who: rng.pick(handles), args: { q: q.postid, on: rng.chance(0.7) } }; },
      (d, a) => d.favorite(a.q, 'Q', a.q, a.on)],
    [2, 'favorite user', w => { const u = rng.pick(w.users); return u && { who: rng.pick(handles), args: { handle: u.handle, userid: u.userid, on: rng.chance(0.7) } }; },
      (d, a) => d.favorite(`/index.php?qa=user/${encodeURIComponent(a.handle)}`, 'U', a.userid, a.on)],
    [2, 'wall post', w => ({ who: rng.pick(handles), args: { to: rng.pick(handles), message: rng.chance(0.05) ? '' : sentence(rng, 2, 12, BMP_WORDS) } }),
      (d, a) => d.wallPost(a.to, a.message)],
    [2, 'private message', w => ({ who: rng.pick(handles), args: { to: rng.pick(handles), message: sentence(rng, 2, 12, BMP_WORDS) } }),
      (d, a) => d.sendMessage(a.to, a.message)],
  ];
  const TOTAL = ACTIONS.reduce((n, [weight]) => n + weight, 0);
  function chooseAction() {
    let r = rng.int(TOTAL);
    for (const action of ACTIONS) { if ((r -= action[0]) < 0) return action; }
    return ACTIONS[0];
  }
  // Each action starts on a fresh second on each site, so its events share a second only with each other,
  // on both sides alike (Q2A trims event streams by time, a whole second at a time).
  async function freshSecond() {
    const wait = 1000 - (Date.now() % 1000) + 20;
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  const trace = () => `seed ${SEED}, ${log.length} actions:\n${log.slice(-15).map((l, i) => `  ${log.length - Math.min(15, log.length) + i + 1}. ${l}`).join('\n')}`;
  const comparable = outcome => ({ accepted: Boolean(outcome?.accepted), message: outcome?.message ?? '' });

  test(`${STEPS} random actions give the same answers and the same database (seed ${SEED})`, async () => {
    for (let step = 1; step <= STEPS; step++) {
      const w = await world();
      const [, name, plan, perform] = chooseAction();
      const planned = plan(w);
      if (!planned) continue;
      log.push(`${name} by ${planned.who} ${JSON.stringify(planned.args)}`);
      await freshSecond();
      const php = comparable(await perform(planned.who === 'anonymous' ? sites.php.anonymous : sites.php.users[planned.who], planned.args));
      await freshSecond();
      const ui = comparable(await perform(planned.who === 'anonymous' ? sites.ui.anonymous : sites.ui.users[planned.who], planned.args));
      if (JSON.stringify(php) !== JSON.stringify(ui)) throw new Error(`Different answers at step ${step}: PHP ${JSON.stringify(php)} vs UI ${JSON.stringify(ui)}\n${trace()}`);
      log[log.length - 1] += php.accepted ? ' → done' : ` → refused${php.message ? `: ${php.message}` : ''}`;
      if (step % DIFF_EVERY === 0 || step === STEPS) {
        await Promise.all([trimEventStreams(phpPool), trimEventStreams(nodePool)]); // Q2A trims a random follower's stream (db-state.js)
        const differences = diffStates(await databaseState(phpPool), await databaseState(nodePool));
        if (differences.length) throw new Error(`Databases differ after step ${step}:\n${JSON.stringify(differences.slice(0, 6), null, 1)}\n${trace()}`);
      }
    }
    const accepted = log.filter(l => l.endsWith('→ done')).length;
    console.log(`Differential run: seed ${SEED}, ${log.length} actions, ${accepted} accepted, ${log.length - accepted} refused on both sites.`);
    expect(accepted).toBeGreaterThan(log.length / 3); // the run must actually change things
  });

  test('the invariants hold, and Node breaks none that PHP keeps', async () => {
    const [php, node] = await Promise.all([checkInvariants(phpPool), checkInvariants(nodePool)]);
    if (Object.keys(php).length) console.log(`Upstream PHP leaves these invariants broken (not a migration difference): ${JSON.stringify(php).slice(0, 600)}`);
    expect(onlyInNode(php, node)).toEqual({});
  });

  // Pages, as the same viewer on both sites, with only per-request values masked (security codes, times).
  function normalise(html) {
    const $ = cheerio.load(html);
    $('input[name=code], input[name$="_code"]').attr('value', 'CODE');
    $('time').each((i, el) => { $(el).attr('datetime', 'T').attr('title', 'T').text('T'); });
    $('[class*="-when-data"]').text('T');
    $('pubDate, pubdate').text('T');
    $('script').each((i, el) => { $(el).text($(el).text().replace(/"code":"[^"]*"|code=[^&"']+/g, 'CODE')); });
    // Ages ("2 seconds", "since Nov 19") depend on when each site ran the action, a second or so apart.
    return $.html().replace(/\b\d+ (second|minute|hour|day|week|month|year)s?\b/g, 'AGE').replace(/\s+/g, ' ');
  }
  function firstDifference(a, b) {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return { php: a.slice(Math.max(0, i - 120), i + 160), ui: b.slice(Math.max(0, i - 120), i + 160) };
  }

  test('every kind of page renders the same for the same viewer', async () => {
    await Promise.all([trimEventStreams(phpPool), trimEventStreams(nodePool)]); // the updates page reads the streams
    const w = await world();
    const questions = w.posts.filter(p => p.type.startsWith('Q')).map(p => p.postid);
    const pages = [
      '', 'questions', 'questions?sort=hot', 'questions?sort=votes', 'questions?sort=answers', 'questions?sort=views', 'unanswered', 'unanswered?by=selected', 'unanswered?by=upvotes',
      'activity', 'tags', 'users', 'users/new', 'categories', 'search&q=cache', 'search&q=%C3%BCber', 'search&q=php+docker', 'feed/qa.rss', 'feed/questions.rss',
      ...w.tags.slice(0, 5).map(t => `tag/${encodeURIComponent(t)}`),
      ...questions.slice(-12).map(String),
      ...handles.slice(0, 3).flatMap(h => [`user/${h}`, `user/${h}/wall`, `user/${h}/activity`, `user/${h}/questions`, `user/${h}/answers`]),
    ];
    const viewers = { anonymous: () => [request.agent(PHP_URL), request.agent(UI_URL)], fzalice: () => [sites.php.users.fzalice._client, sites.ui.users.fzalice._client] };
    const adminPages = ['admin/flagged', 'admin/hidden', 'admin/moderate', 'admin/users', 'favorites', 'updates', 'messages', 'account'];
    const mismatches = [];
    for (const [viewer, clients] of Object.entries(viewers)) {
      const [phpClient, uiClient] = clients();
      for (const path of pages) {
        const [p, u] = await Promise.all([phpClient.get(`/index.php?qa=${path}`).redirects(3), uiClient.get(`/index.php?qa=${path}`).redirects(3)]);
        const [a, b] = [normalise(p.text), normalise(u.text)];
        if (p.status !== u.status || a !== b) mismatches.push({ viewer, path, status: [p.status, u.status], ...firstDifference(a, b) });
      }
    }
    for (const path of adminPages) {
      const [p, u] = await Promise.all([sites.php.users.fzadmin._client.get(`/index.php?qa=${path}`).redirects(3), sites.ui.users.fzadmin._client.get(`/index.php?qa=${path}`).redirects(3)]);
      const [a, b] = [normalise(p.text), normalise(u.text)];
      if (p.status !== u.status || a !== b) mismatches.push({ viewer: 'fzadmin', path, status: [p.status, u.status], ...firstDifference(a, b) });
    }
    if (mismatches.length) throw new Error(`${mismatches.length} pages differ (seed ${SEED}):\n${JSON.stringify(mismatches.slice(0, 4), null, 1)}`);
  });

  test('options present on one side only are just ones read on different pages', () => {
    // Informational: listed for inspection, not a failure (see db-state.js).
    return Promise.all([databaseState(phpPool), databaseState(nodePool)]).then(([a, b]) => {
      const one = optionsOnlyOnOneSide(a, b);
      if (one.php.length || one.node.length) console.log(`Options stored on one side only: ${JSON.stringify(one)}`);
    });
  });
});
