// Posting parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each
// ask questions, answer and comment against identical fixture posts. Outcomes, the messages the
// pages show, and every database value qa_question_create(), qa_answer_create() and
// qa_comment_create() write (including the word index, cached counts, points, rate limits,
// update streams and visitor cookies) must match.
const request = require('supertest');
const cheerio = require('cheerio');
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');

const PHP_URL = process.env.PHP_URL || 'http://localhost:8080';
const UI_URL = process.env.MIGRATED_UI_URL || 'http://localhost:8081';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const clean = value => value.replace(/\s+/g, ' ').trim();

// Messages a Q2A page shows: the page error plus any field errors, in page order.
function pageMessages(html) {
  const $ = cheerio.load(html);
  return $('.qa-error, .qa-form-tall-error').map((i, el) => clean($(el).text())).get().filter(Boolean).join(' | ');
}

// Drives the original pages exactly as a browser submits them (the editor fields included).
function siteDriver(name, baseUrl, pool) {
  const client = request.agent(baseUrl);
  // Question pages redirect to their canonical URL, and a POST to any other URL is redirected unprocessed.
  async function questionPage(questionid, state) {
    const page = await client.get(`/index.php?qa=${questionid}${state ? `&state=${state}` : ''}`).redirects(3);
    const url = new URL(page.redirects.at(-1) ?? `${baseUrl}/index.php?qa=${questionid}`);
    url.searchParams.delete('state');
    return { $: cheerio.load(page.text), path: url.pathname + url.search };
  }
  function outcome(response, idPattern) {
    if (response.status === 302) {
      const id = idPattern.exec(response.headers.location ?? '');
      return { accepted: true, id: id ? Number(id[1] ?? id[2]) : null, backend: response.headers['x-q2a-post-backend'] };
    }
    return { accepted: false, message: pageMessages(response.text) };
  }
  return {
    name, pool,
    async register(handle) {
      const page = await client.get('/?qa=register').expect(200);
      const code = cheerio.load(page.text)('[name=doregister]').closest('form').find('[name=code]').val();
      const response = await client.post('/?qa=register').type('form')
        .send({ handle, email: `${handle}@example.test`, password: 'Password123!', code, doregister: '1' });
      expect(response.status).toBe(302);
    },
    async ask(input) {
      const path = `/index.php?qa=ask${input.followAnswerId ? `&follow=${input.followAnswerId}` : ''}`;
      const page = await client.get(path).expect(200);
      const code = cheerio.load(page.text)('[name=doask]').closest('form').find('[name=code]').val() ?? 'none';
      const form = {
        title: input.title, content: input.content, content_ckeditor_ok: input.format === 'html' ? '1' : '0',
        editor: 'WYSIWYG Editor', tags: input.tags ?? '', name: input.name ?? '', email: input.email ?? '', code, doask: '1',
      };
      if (input.notify) form.notify = '1';
      return outcome(await client.post(path).type('form').send(form), /qa=(\d+)|^\.?\/?(\d+)\//);
    },
    async answer(questionid, input) {
      const { $, path } = await questionPage(questionid, 'answer');
      const code = $('[name=a_doadd]').closest('form').find('[name=code]').val() ?? 'none';
      const form = { a_content: input.content, a_content_ckeditor_ok: '0', a_editor: 'WYSIWYG Editor', a_name: input.name ?? '', a_email: input.email ?? '', code, a_doadd: '1' };
      if (input.notify) form.a_notify = '1';
      return outcome(await client.post(path).type('form').send(form), /show=(\d+)/);
    },
    async comment(questionid, parentid, input) {
      const { $, path } = await questionPage(questionid, `comment-${parentid}`);
      const prefix = `c${parentid}_`;
      const form = {
        [`${prefix}content`]: input.content, [`${prefix}editor`]: '', [`${prefix}name`]: input.name ?? '', [`${prefix}email`]: input.email ?? '',
        [`${prefix}code`]: $(`[name=${prefix}code]`).val() ?? 'none', [`${prefix}doadd`]: '1',
      };
      if (input.notify) form[`${prefix}notify`] = '1';
      return outcome(await client.post(path).type('form').send(form), /show=(\d+)/);
    },
  };
}

function apiDriver(pool) {
  const client = request.agent(API_URL);
  const send = async (path, body) => {
    const response = await client.post(path).set('X-Q2A-Request', '1').send(body);
    return response.status === 201
      ? { accepted: true, id: response.body.id }
      : { accepted: false, status: response.status, code: response.body.error?.code, fields: response.body.error?.fields };
  };
  const common = input => ({ content: input.content, format: input.format ?? '', notify: Boolean(input.notify), email: input.email ?? '', name: input.name ?? '' });
  return {
    name: 'node-api', pool,
    async register(handle) {
      await client.post('/api/v1/auth/register').set('X-Q2A-Request', '1')
        .send({ handle, email: `${handle}@example.test`, password: 'Password123!' }).expect(201);
    },
    ask: input => send('/api/v1/questions', { ...common(input), title: input.title, tags: input.tags ?? '', followAnswerId: input.followAnswerId }),
    answer: (questionid, input) => send(`/api/v1/questions/${questionid}/answers`, common(input)),
    comment: (questionid, parentid, input) => send(`/api/v1/posts/${parentid}/comments`, common(input)),
  };
}

// Identical fixture posts in each database. Fixed timestamps keep them comparable.
async function createFixtures(pool, handles, token) {
  const users = {};
  for (const [label, handle] of Object.entries(handles)) {
    const [[row]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [handle]);
    users[label] = row.userid;
  }
  const insert = async (type, parentid, userid, created, title, content, acount = 0) => {
    const [result] = await pool.execute(
      "INSERT INTO qa_posts (type,parentid,userid,created,title,content,format,tags,acount) VALUES (?,?,?,?,?,?,'','',?)",
      [type, parentid, userid, created, title, content, acount]);
    return result.insertId;
  };
  const ids = {};
  ids.q = await insert('Q', null, users.owner, '2026-02-01 10:00:00', `Fixture question ${token} about caching`, 'How should I cache rendered pages?');
  ids.qa = await insert('Q', null, users.owner, '2026-02-01 11:00:00', `Answered fixture ${token} question`, 'Which database index helps here?', 1);
  ids.a = await insert('A', ids.qa, users.owner, '2026-02-01 12:00:00', null, 'Add a composite index on the filtered columns.');
  ids.c1 = await insert('C', ids.a, users.other, '2026-02-01 13:00:00', null, 'Would a covering index be better here?');
  ids.hidden = await insert('Q_HIDDEN', null, users.owner, '2026-02-01 10:00:00', `Hidden fixture ${token} question`, 'Hidden body text');
  // Q2A keeps these totals consistent as posts are created; recount them for the new fixtures.
  for (const [key, where] of [
    ['cache_qcount', "type='Q'"], ['cache_acount', "type='A'"], ['cache_ccount', "type='C'"],
    ['cache_unaqcount', "type='Q' AND acount=0 AND closedbyid IS NULL"], ['cache_unselqcount', "type='Q' AND selchildid IS NULL AND closedbyid IS NULL"],
    ['cache_unupaqcount', "type='Q' AND amaxvote=0 AND closedbyid IS NULL"], ['cache_queuedcount', "type IN ('Q_QUEUED','A_QUEUED','C_QUEUED')"],
  ]) {
    await pool.query(`INSERT INTO qa_options (title,content) SELECT ?, COUNT(*) FROM qa_posts WHERE ${where} ON DUPLICATE KEY UPDATE content=VALUES(content)`, [key]);
  }
  return { ids, users };
}

const CACHES = ['cache_qcount', 'cache_acount', 'cache_ccount', 'cache_unaqcount', 'cache_unselqcount', 'cache_unupaqcount', 'cache_queuedcount', 'cache_userpointscount'];

// Everything the create functions write, with IDs replaced by labels and the per-backend token masked.
async function snapshot(backend, newId) {
  const { pool } = backend.actor;
  const { ids, users, token } = backend;
  const postLabel = new Map(Object.entries(ids).map(([label, id]) => [Number(id), label]));
  if (newId) postLabel.set(Number(newId), 'new');
  const userLabel = new Map(Object.entries(users).map(([label, id]) => [Number(id), label]));
  const pl = id => (id === null ? null : postLabel.get(Number(id)) ?? 'other-post');
  const ul = id => (id === null ? null : userLabel.get(Number(id)) ?? 'other-user');
  const mask = value => (typeof value === 'string' ? value.split(token).join('<token>') : value);
  const sortRows = rows => rows.map(row => JSON.stringify(row)).sort();

  // A question's hotness is checked against the formula for its current answers and votes
  // (the timestamps differ between backends, so the raw values cannot be compared).
  const hotnessOk = async postid => {
    const [[row]] = await pool.execute(
      "SELECT p.hotness, ((TO_DAYS(p.created)-734138)*86400.0+TIME_TO_SEC(p.created))*100 + ((TO_DAYS(COALESCE(MAX(c.created),p.created))-734138)*86400.0+TIME_TO_SEC(COALESCE(MAX(c.created),p.created)))*100 " +
      "+ COUNT(c.postid)*100*160000 + p.netvotes*100*160000 + p.views*100*4000 AS expected FROM qa_posts p LEFT JOIN qa_posts c ON c.parentid=p.postid AND c.type='A' WHERE p.postid=? GROUP BY p.postid", [postid]);
    return Math.abs(Number(row.hotness) - Number(row.expected)) <= Math.abs(Number(row.expected)) * 1e-6;
  };

  const posts = {};
  const postIds = [...postLabel.keys()];
  const [postRows] = await pool.query(
    'SELECT postid, type, parentid, userid, CAST(cookieid AS CHAR) AS cookieid, INET6_NTOA(createip) AS createip, title, content, format, tags, notify, name, categoryid, catidpath1, ' +
    'acount, amaxvote, upvotes, downvotes, netvotes, flagcount, selchildid, closedbyid, created IS NOT NULL AS hascreated FROM qa_posts WHERE postid IN (?)', [postIds]);
  const cookieids = [];
  for (const row of postRows) {
    const label = postLabel.get(Number(row.postid));
    if (row.cookieid) cookieids.push(row.cookieid);
    posts[label] = {
      ...row, postid: undefined, cookieid: row.cookieid !== null, parentid: pl(row.parentid), userid: ul(row.userid),
      title: mask(row.title), content: mask(row.content), tags: mask(row.tags),
      hotnessOk: row.type.startsWith('Q') && label !== 'hidden' ? await hotnessOk(row.postid) : undefined,
    };
  }

  const [metas] = newId ? await pool.query('SELECT title, content FROM qa_postmetas WHERE postid=?', [newId]) : [[]];
  const index = {};
  if (newId) {
    const words = async (table, extra = '') => {
      const [rows] = await pool.query(`SELECT w.word${extra} FROM ${table} t JOIN qa_words w USING (wordid) WHERE t.postid=?`, [newId]);
      return sortRows(rows.map(row => ({ ...row, word: mask(row.word), questionid: row.questionid === undefined ? undefined : pl(row.questionid) })));
    };
    index.title = await words('qa_titlewords');
    index.content = await words('qa_contentwords', ', t.count, t.type, t.questionid');
    index.tagwords = await words('qa_tagwords');
    index.posttags = await words('qa_posttags');
  }

  const [wordRows] = await pool.query('SELECT word, titlecount, contentcount, tagwordcount, tagcount FROM qa_words');
  const words = new Map(wordRows.map(row => [mask(row.word), [row.titlecount, row.contentcount, row.tagwordcount, row.tagcount].map(Number)]));

  const caches = {};
  for (const name of CACHES) {
    const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [name]);
    caches[name] = row ? Number(row.content) : 0;
  }
  const [[tagcount]] = await pool.query("SELECT (SELECT content FROM qa_options WHERE title='cache_tagcount') AS cached, (SELECT COUNT(*) FROM qa_words WHERE tagcount>0) AS actual");

  const points = {};
  for (const [label, userid] of Object.entries(users)) {
    const [[row]] = await pool.execute('SELECT * FROM qa_userpoints WHERE userid=?', [userid]);
    if (row) delete row.userid;
    points[label] = row ?? null;
  }
  const limits = {};
  for (const action of ['Q', 'A', 'C']) {
    const [[user]] = await pool.execute('SELECT COALESCE(SUM(count),0) AS n FROM qa_userlimits WHERE userid=? AND action=? AND period=FLOOR(UNIX_TIMESTAMP()/3600)', [users.actor, action]);
    const [[ip]] = await pool.execute('SELECT COALESCE(SUM(count),0) AS n FROM qa_iplimits WHERE action=? AND period=FLOOR(UNIX_TIMESTAMP()/3600)', [action]);
    limits[action] = [Number(user.n), Number(ip.n)];
  }
  const [[actor]] = await pool.execute('SELECT written IS NOT NULL AS written, INET6_NTOA(writeip) AS writeip FROM qa_users WHERE userid=?', [users.actor]);

  // Update streams for every question involved.
  const questionIds = postIds.filter(id => ['q', 'qa', 'hidden', 'new'].includes(postLabel.get(id)));
  const eventEntity = async row => {
    if (row.entitytype === 'Q') return pl(row.entityid);
    if (row.entitytype === 'U') return ul(row.entityid);
    if (row.entitytype === 'T') {
      const [[word]] = await pool.execute('SELECT word FROM qa_words WHERE wordid=?', [row.entityid]);
      return mask(word?.word);
    }
    return row.entityid;
  };
  const [shared] = await pool.query('SELECT entitytype, entityid, questionid, lastpostid, updatetype, lastuserid FROM qa_sharedevents WHERE questionid IN (?)', [questionIds]);
  const [personal] = await pool.query('SELECT userid, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid FROM qa_userevents WHERE questionid IN (?)', [questionIds]);
  const normalizeEvent = async row => ({ ...row, entityid: await eventEntity(row), questionid: pl(row.questionid), lastpostid: pl(row.lastpostid), lastuserid: ul(row.lastuserid), userid: row.userid === undefined ? undefined : ul(row.userid) });
  const events = { shared: sortRows(await Promise.all(shared.map(normalizeEvent))), personal: sortRows(await Promise.all(personal.map(normalizeEvent))) };

  const [cookies] = cookieids.length
    ? await pool.query('SELECT INET6_NTOA(createip) AS createip, written IS NOT NULL AS written, INET6_NTOA(writeip) AS writeip FROM qa_cookies WHERE cookieid IN (?)', [cookieids])
    : [[]];

  return { posts, metas, index, words, caches, tagcountConsistent: Number(tagcount.cached) === Number(tagcount.actual), points, limits, actor, events, cookies: sortRows(cookies) };
}

// Values that depend on each database's earlier history are compared as changes.
function comparable(before, after) {
  const wordDelta = {};
  for (const [word, counts] of after.words) {
    const old = before.words.get(word) ?? [0, 0, 0, 0];
    const delta = counts.map((value, i) => value - old[i]);
    if (delta.some(Boolean)) wordDelta[word] = delta;
  }
  return {
    ...after,
    words: wordDelta,
    caches: Object.fromEntries(CACHES.map(key => [key, after.caches[key] - before.caches[key]])),
    limits: Object.fromEntries(Object.keys(after.limits).map(key => [key, after.limits[key].map((value, i) => value - before.limits[key][i])])),
  };
}

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
    expect(ui.state).toEqual(php.state);
    expect(api.state).toEqual(php.state);
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
