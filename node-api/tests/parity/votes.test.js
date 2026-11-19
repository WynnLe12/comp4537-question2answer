// Voting parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API
// each perform the same votes against their own fixture posts. Outcomes, user-visible
// responses and every database value PHP's qa_vote_set() writes must match.
const request = require('supertest');
const cheerio = require('cheerio');
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { limitRows, limitDelta } = require('./post-helpers');

const PHP_URL = process.env.PHP_URL || 'http://localhost:8080';
const UI_URL = process.env.MIGRATED_UI_URL || 'http://localhost:8081';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const MISSING_POST = 4294967000;
const text = html => cheerio.load(`<div>${html}</div>`)('div').first().text().replace(/\s+/g, ' ').trim();

// Drives the original Q2A pages: registration form, then the same ajax request qa_vote_click() sends.
function siteDriver(name, baseUrl, pool) {
  const client = request.agent(baseUrl);
  let carrier;
  return {
    name, pool,
    async register(handle) {
      const page = await client.get('/?qa=register').expect(200);
      const code = cheerio.load(page.text)('[name=doregister]').closest('form').find('[name=code]').val();
      const response = await client.post('/?qa=register').type('form')
        .send({ handle, email: `${handle}@example.test`, password: 'Password123!', code, doregister: '1' });
      expect(response.status).toBe(302);
    },
    useCarrier(postid) { carrier = postid; },
    async vote(postid, vote) {
      // The vote security code is per user/session, so it can come from any visible question page.
      const page = await client.get(`/?qa=${carrier}`).redirects(2).expect(200);
      const code = cheerio.load(page.text)('[name^="vote_"]').first().closest('form').find('[name=code]').val() || 'none';
      const response = await client.post('/index.php').type('form').send({
        qa: 'ajax', qa_operation: 'vote', qa_root: './', qa_request: String(carrier), postid: String(postid), vote: String(vote), code,
      }).expect(200);
      const lines = response.text.slice(response.text.indexOf('QA_AJAX_RESPONSE')).split('\n');
      return { accepted: lines[1] === '1', message: text(lines.slice(2).join('\n')), backend: response.headers['x-q2a-vote-backend'] };
    },
  };
}

function apiDriver(pool) {
  const client = request.agent(API_URL);
  return {
    name: 'node-api', pool,
    async register(handle) {
      await client.post('/api/v1/auth/register').set('X-Q2A-Request', '1')
        .send({ handle, email: `${handle}@example.test`, password: 'Password123!' }).expect(201);
    },
    useCarrier() {},
    async vote(postid, vote) {
      // The API accepts only -1, 0 or 1; PHP clamps other numbers before voting.
      const response = await client.put(`/api/v1/posts/${postid}/vote`).set('X-Q2A-Request', '1')
        .send({ vote: Math.max(-1, Math.min(1, vote)) });
      return { accepted: response.status === 200, code: response.body.error?.code, status: response.status };
    },
  };
}

// Identical fixture posts are inserted directly into each database because post creation
// has not been migrated yet. Fixed timestamps keep hotness values comparable.
async function createFixtures(pool, ownerHandle) {
  const [[{ userid: owner }]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [ownerHandle]);
  const insert = async (type, parentid, created, userid = owner, acount) => {
    const [result] = await pool.execute(
      "INSERT INTO qa_posts (type,parentid,userid,created,title,content,format,tags,acount) VALUES (?,?,?,?,?,'Body','','',?)",
      [type, parentid, userid, created, type.startsWith('Q') ? `Vote parity fixture ${type}` : null, acount ?? (type === 'Q' && userid ? 1 : 0)],
    );
    return result.insertId;
  };
  const q = await insert('Q', null, '2026-01-15 12:00:00');
  const ids = {
    owner, q,
    // Page views change hotness, so the form code comes from an anonymous question that is
    // never voted on (everyone, including the owner, sees its vote buttons).
    carrier: await insert('Q', null, '2026-01-15 12:00:00', null),
    a: await insert('A', q, '2026-01-15 13:00:00'),
    c: await insert('C', q, '2026-01-15 14:00:00'),
    hidden: await insert('Q_HIDDEN', null, '2026-01-15 12:00:00'),
    queued: await insert('Q_QUEUED', null, '2026-01-15 12:00:00'),
    missing: MISSING_POST,
  };
  // A second question with two answers exercises the full amaxvote recount.
  ids.q2 = await insert('Q', null, '2026-01-16 12:00:00', owner, 2);
  ids.b1 = await insert('A', ids.q2, '2026-01-16 13:00:00');
  ids.b2 = await insert('A', ids.q2, '2026-01-16 14:00:00');
  // Q2A recounts this cache when questions are created; keep it consistent for the new fixtures.
  await pool.query("INSERT INTO qa_options (title,content) SELECT 'cache_unupaqcount', COUNT(*) FROM qa_posts WHERE type='Q' AND amaxvote=0 AND closedbyid IS NULL " +
    'ON DUPLICATE KEY UPDATE content=VALUES(content)');
  return ids;
}

async function snapshot(pool, ids, voterHandle) {
  const [[voter]] = await pool.execute('SELECT userid, written IS NOT NULL AS written, INET6_NTOA(writeip) AS writeip FROM qa_users WHERE handle=?', [voterHandle]);
  const labels = ['q', 'a', 'c', 'hidden', 'queued', 'q2', 'b1', 'b2'];
  const posts = {};
  const votes = {};
  for (const label of labels) {
    const [[post]] = await pool.execute('SELECT upvotes,downvotes,netvotes,acount,amaxvote,hotness,flagcount FROM qa_posts WHERE postid=?', [ids[label]]);
    posts[label] = post;
    const [[vote]] = await pool.execute(
      'SELECT vote,flag,votecreated IS NOT NULL AS created,voteupdated IS NOT NULL AS updated FROM qa_uservotes WHERE postid=? AND userid=?',
      [ids[label], voter.userid],
    );
    votes[label] = vote ?? null;
  }
  const points = {};
  for (const [label, userid] of [['voter', voter.userid], ['owner', ids.owner]]) {
    const [[row]] = await pool.execute('SELECT * FROM qa_userpoints WHERE userid=?', [userid]);
    delete row.userid;
    points[label] = row;
  }
  const limit = await limitRows(pool, "SELECT userid AS k, period, count FROM qa_userlimits WHERE userid=? AND action='V'", [voter.userid]);
  const ipLimit = await limitRows(pool, "SELECT HEX(ip) AS k, period, count FROM qa_iplimits WHERE action='V'", []);
  const caches = {};
  for (const name of ['cache_unupaqcount', 'cache_userpointscount']) {
    const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [name]);
    caches[name] = row ? Number(row.content) : 0;
  }
  return { posts, votes, points, userVoteLimit: limit, ipVoteLimit: ipLimit, caches,
    written: Boolean(voter.written), writeip: voter.writeip };
}

// Values that legitimately depend on each database's earlier history are compared as deltas.
function comparable(before, after) {
  return {
    ...after,
    userVoteLimit: limitDelta(before.userVoteLimit, after.userVoteLimit),
    ipVoteLimit: limitDelta(before.ipVoteLimit, after.ipVoteLimit),
    caches: Object.fromEntries(Object.keys(after.caches).map(key => [key, after.caches[key] - before.caches[key]])),
  };
}

describe('PHP ↔ Node voting parity (original ajax endpoint, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    backends = [];
    for (const [tag, make] of [
      ['p', () => siteDriver('php', PHP_URL, phpPool)],
      ['u', () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', () => apiDriver(nodePool)],
    ]) {
      const voter = make();
      const owner = make();
      const backend = { voter, owner, voterHandle: `vv${tag}${suffix}`, ownerHandle: `vo${tag}${suffix}` };
      await owner.register(backend.ownerHandle);
      await voter.register(backend.voterHandle);
      backend.ids = await createFixtures(voter.pool, backend.ownerHandle);
      voter.useCarrier(backend.ids.carrier);
      owner.useCarrier(backend.ids.carrier);
      backends.push(backend);
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  async function runEverywhere(perform) {
    const results = [];
    for (const backend of backends) {
      const before = await snapshot(backend.voter.pool, backend.ids, backend.voterHandle);
      const outcome = await perform(backend);
      const after = await snapshot(backend.voter.pool, backend.ids, backend.voterHandle);
      results.push({ outcome, state: comparable(before, after) });
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.outcome.message).toBe(php.outcome.message);
    expect(ui.state).toEqual(php.state);
    expect(api.state).toEqual(php.state);
    return { php, ui, api };
  }

  test.each([
    ['upvotes a question', 'q', 1, true],
    ['ignores a repeated identical vote', 'q', 1, true],
    ['switches to a downvote', 'q', -1, true],
    ['removes the vote', 'q', 0, true],
    ['clamps an out-of-range vote to +1', 'q', 5, true],
    ['upvotes an answer and raises the question amaxvote', 'a', 1, true],
    ['downvotes the answer and recalculates amaxvote', 'a', -1, true],
    ['removes the answer vote', 'a', 0, true],
    ['upvotes one of two answers', 'b1', 1, true],
    ['downvotes it, forcing a full amaxvote recount', 'b1', -1, true],
    ['rejects voting on a hidden post', 'hidden', 1, false],
    ['rejects voting on a queued post', 'queued', 1, false],
    ['rejects comment voting while it is disabled', 'c', 1, false],
    ['rejects a missing post', 'missing', 1, false],
  ])('%s', async (name, label, vote, accepted) => {
    const { php, ui, api } = await runEverywhere(backend => backend.voter.vote(backend.ids[label], vote));
    expect(php.outcome.accepted).toBe(accepted);
    if (accepted) expect(php.state.written).toBe(true);
    // A post that does not exist is rejected by PHP's own post lookup before any write is attempted.
    if (label !== 'missing') expect(ui.outcome.backend).toBe('node-api-v1');
    if (!accepted) expect(api.outcome.code).toEqual(expect.any(String));
  });

  test('records the voter IP address as PHP does', async () => {
    const states = await Promise.all(backends.map(b => snapshot(b.voter.pool, b.ids, b.voterHandle)));
    expect(states[0].writeip).toBeTruthy();
    expect(states[1].writeip).toBe(states[0].writeip);
    expect(states[2].writeip).toBe(states[0].writeip);
  });

  test('rejects voting on your own post', async () => {
    const { php, api } = await runEverywhere(backend => backend.owner.vote(backend.ids.q, 1));
    expect(php.outcome).toMatchObject({ accepted: false, message: 'Voting on this is not allowed' });
    expect(api.outcome).toMatchObject({ status: 403, code: 'vote_not_allowed' });
  });

  test('anonymous visitors are asked to log in', async () => {
    const { php, api } = await runEverywhere(backend => {
      const driver = backend.voter.name === 'node-api' ? apiDriver(backend.voter.pool)
        : siteDriver(backend.voter.name, backend.voter.name === 'php' ? PHP_URL : UI_URL, backend.voter.pool);
      driver.useCarrier(backend.ids.carrier);
      return driver.vote(backend.ids.q, 1);
    });
    expect(php.outcome.message).toBe('Please log in or register to vote.');
    expect(api.outcome).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  test('enforces the hourly per-user vote limit', async () => {
    for (const backend of backends) {
      await backend.voter.pool.execute(
        "INSERT INTO qa_userlimits (userid,action,period,count) SELECT userid,'V',FLOOR(UNIX_TIMESTAMP()/3600),60000 FROM qa_users WHERE handle=? " +
        'ON DUPLICATE KEY UPDATE period=VALUES(period), count=60000', [backend.voterHandle]);
    }
    try {
      const { php, api } = await runEverywhere(backend => backend.voter.vote(backend.ids.q, -1));
      expect(php.outcome).toMatchObject({ accepted: false, message: 'Too many votes received - please try again in an hour' });
      expect(api.outcome).toMatchObject({ status: 429, code: 'vote_limit' });
    } finally {
      for (const backend of backends) {
        await backend.voter.pool.execute("DELETE l FROM qa_userlimits l JOIN qa_users u USING(userid) WHERE u.handle=? AND l.action='V'", [backend.voterHandle]);
      }
    }
  });

  test('blocked users cannot vote', async () => {
    const setBlocked = on => Promise.all(backends.map(b => b.voter.pool.execute(
      `UPDATE qa_users SET flags = flags ${on ? '| 2' : '& ~2'} WHERE handle=?`, [b.voterHandle])));
    await setBlocked(true);
    try {
      const { php, api } = await runEverywhere(backend => backend.voter.vote(backend.ids.q, -1));
      expect(php.outcome).toMatchObject({ accepted: false, message: 'You do not have permission to perform this operation' });
      expect(api.outcome).toMatchObject({ status: 403, code: 'no_permission' });
    } finally { await setBlocked(false); }
  });

  test('down-vote permission is checked separately from up-voting', async () => {
    const pools = [phpPool, nodePool];
    const previous = [];
    for (const pool of pools) {
      const [[row]] = await pool.execute("SELECT content FROM qa_options WHERE title='permit_vote_down'");
      previous.push(row?.content);
      await pool.execute("INSERT INTO qa_options (title,content) VALUES ('permit_vote_down','100') ON DUPLICATE KEY UPDATE content='100'");
    }
    try {
      const down = await runEverywhere(backend => backend.voter.vote(backend.ids.q, -1));
      expect(down.php.outcome).toMatchObject({ accepted: false, message: 'You do not have permission to perform this operation' });
      expect(down.api.outcome.code).toBe('no_permission');
      const up = await runEverywhere(backend => backend.voter.vote(backend.ids.q, 0));
      expect(up.php.outcome.accepted).toBe(true);
    } finally {
      for (const [index, pool] of pools.entries()) {
        if (previous[index] === undefined) await pool.execute("DELETE FROM qa_options WHERE title='permit_vote_down'");
        else await pool.execute("UPDATE qa_options SET content=? WHERE title='permit_vote_down'", [previous[index]]);
      }
    }
  });
});
