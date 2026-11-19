// Read parity: every db/selects.php builder the shared UI now sends to Node is run both ways against the
// same database: through PHP's own builders and qa_db_single_select (docker/php/read-harness.php on the
// shared UI, with the bridge switched off) and through the Node API's internal reads. Results, their
// keys, their order and every byte of every value must match. The shared UI's pages are also loaded to
// check they render from Node's reads.
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { createPool } = require('../../src/db');
const { UI_URL, API_URL, siteDriver } = require('./post-helpers');
const { KEY, normalise, canonResult, runReads, CASES, HELPER_CASES, buildFixtures } = require('./read-cases');

describe('PHP ↔ Node read parity (db/selects.php builders and the shared UI pages)', () => {
  const suffix = randomBytes(3).toString('hex');
  let pool, fixtures, php, node, phpHelpers, nodeHelpers;
  // Everything the fixtures change is put back afterwards: a category on the site, for one, makes
  // Q2A require a category for every new question, which would break the other suites.
  const undo = [];

  beforeAll(async () => {
    pool = createPool();
    fixtures = await buildFixtures(pool, suffix, undo);
    const helperReads = HELPER_CASES.map(([, name, args]) => ({ name, args: args(fixtures) }));
    [phpHelpers, nodeHelpers] = await Promise.all([runReads(`${UI_URL}/docker/php/read-harness.php`, helperReads), runReads(`${API_URL}/api/v1/internal/reads`, helperReads)]);
    const reads = [...CASES.map(([, name, args, count]) => ({ name, args: args(fixtures), count: !!count })), { name: 'qa_db_time_selectspec', args: [] }];
    [php, node] = await Promise.all([runReads(`${UI_URL}/docker/php/read-harness.php`, reads), runReads(`${API_URL}/api/v1/internal/reads`, reads)]);
  });
  afterAll(async () => {
    for (const step of undo.reverse()) await step();
    await pool.end();
  });

  test.each(CASES.map(([label], index) => [label, index]))('%s', (label, index) => {
    expect(normalise(node[index])).toEqual(normalise(php[index]));
  });

  test.each(HELPER_CASES.map(([label], index) => [label, index]))('helper: %s', (label, index) => {
    expect(canonResult(nodeHelpers[index])).toEqual(canonResult(phpHelpers[index]));
  });

  test('helper fixtures found real rows', () => {
    for (const label of ['user by email', 'external login', 'notices', 'one vote', 'blob', 'cached image', 'cookie exists', 'category parent', 'unapproved users']) {
      const result = phpHelpers[HELPER_CASES.findIndex(([name]) => name === label)];
      expect([label, result.single ? result.value !== null && result.value !== false : result.entries.length > 0]).toEqual([label, true]);
    }
  });

  test('the bridge stores scaled images through Node', async () => {
    const cacheid = String(800000000 + parseInt(suffix, 16) % 99999999);
    const content = Buffer.from([1, 2, 3, 0, 250]).toString('base64');
    const res = await request(API_URL).post('/api/v1/internal/cache').set('X-Q2A-Bridge-Key', KEY).send({ type: 'i_reads', cacheid, content });
    expect(res.status).toBe(204);
    const [[row]] = await pool.query("SELECT content, lastread>=NOW()-INTERVAL 5 SECOND AS fresh FROM qa_cache WHERE type='i_reads' AND cacheid=?", [cacheid]);
    expect([row.content.toString('base64'), Number(row.fresh)]).toEqual([content, 1]);
    await pool.query("DELETE FROM qa_cache WHERE type='i_reads' AND cacheid=?", [cacheid]);
    expect((await request(API_URL).post('/api/v1/internal/cache').send({ type: 'i_reads', cacheid, content })).status).toBe(404);
  });

  test('the database time agrees', () => {
    const at = CASES.length;
    expect(node[at].entries.map(([key]) => key)).toEqual(php[at].entries.map(([key]) => key));
    const [[, nodeTime]] = node[at].entries;
    const [[, phpTime]] = php[at].entries;
    expect(Math.abs(Number(nodeTime) - Number(Buffer.from(phpTime.b64, 'base64').toString()))).toBeLessThanOrEqual(2);
  });

  test('fixtures found real rows for the key reads', () => {
    for (const label of ['recent questions', 'child posts', 'popular tags', 'top users', 'category by slugs', 'favorite questions', 'post meta']) {
      const result = php[CASES.findIndex(([name]) => name === label)];
      expect(result.single ? result.value : result.entries.length).toBeTruthy();
    }
  });

  test('internal reads need the bridge key and known builders', async () => {
    const reads = [{ name: 'qa_db_options_selectspec', args: [] }];
    expect((await request(API_URL).post('/api/v1/internal/reads').send({ reads })).status).toBe(404);
    expect((await request(API_URL).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', 'wrong').send({ reads })).status).toBe(404);
    expect((await request(`${UI_URL}/docker/php/read-harness.php`).post('').send({ reads })).status).toBe(404);
    const bad = await request(API_URL).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', KEY).send({ reads: [{ name: 'qa_db_connect', args: [] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_input');
  });

  test.each([
    '/', '/index.php?qa=questions', '/index.php?qa=questions&sort=hot', '/index.php?qa=unanswered', '/index.php?qa=activity',
    '/index.php?qa=tags', '/index.php?qa=users', '/index.php?qa=categories', '/index.php?qa=search&q=database', '/index.php?qa=admin',
  ])('shared UI page %s renders from Node reads', async path => {
    const res = await request(UI_URL).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['x-q2a-read-backend']).toBe('node-api-v1');
    expect(res.text).toContain('qa-body-wrapper');
    expect(res.text).not.toMatch(/fatal error|Warning:|Notice:/i);
  });

  // Signed-in pages read more (messages, favorites, updates, admin lists) and load more page code.
  test('signed-in user and admin pages render from Node reads', async () => {
    const member = siteDriver('migrated-ui', UI_URL, pool);
    const admin = siteDriver('migrated-ui', UI_URL, pool);
    await member.register(`rdm${suffix}`);
    await admin.register(`rda${suffix}`);
    await pool.query('UPDATE qa_users SET level=120 WHERE handle=?', [`rda${suffix}`]);
    const pages = [
      [member, ['account', 'favorites', 'updates', 'messages', 'messages/sent', `message/${fixtures.handle}`, `user/${fixtures.handle}`, `user/${fixtures.handle}/wall`, `user/${fixtures.handle}/activity`, 'ask', 'feedback', `${fixtures.q}`]],
      [admin, ['admin/general', 'admin/emails', 'admin/users', 'admin/layout', 'admin/posting', 'admin/viewing', 'admin/lists', 'admin/categories', 'admin/permissions', 'admin/pages', 'admin/feeds', 'admin/points', 'admin/spam', 'admin/caching', 'admin/stats', 'admin/mailing', 'admin/plugins', 'admin/moderate', 'admin/flagged', 'admin/hidden', 'admin/approve', 'admin/userfields', 'admin/usertitles', 'admin/layoutwidgets', 'admin/recalc', `ip/${fixtures.ip}`, 'users/special', 'users/blocked']],
    ];
    for (const [driver, paths] of pages) {
      for (const path of paths) {
        const res = await driver._get(`/index.php?qa=${encodeURI(path)}`);
        expect([path, res.status]).toEqual([path, 200]);
        expect([path, res.headers['x-q2a-read-backend']]).toEqual([path, 'node-api-v1']);
        expect([path, /fatal error|Uncaught|Warning<\/b>|Notice<\/b>|Deprecated<\/b>/i.test(res.text)]).toEqual([path, false]);
      }
    }
  });

  test('question, user and tag pages render from Node reads', async () => {
    for (const path of [`/index.php?qa=${fixtures.q}`, `/index.php?qa=user/${encodeURIComponent(fixtures.handle)}`, `/index.php?qa=tag/${encodeURIComponent(fixtures.tag)}`, `/index.php?qa=questions/reads-${suffix}/child-${suffix}`]) {
      const res = await request(UI_URL).get(path).redirects(3);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers['x-q2a-read-backend']).toBe('node-api-v1');
      expect(res.text).not.toMatch(/fatal error|Warning:|Notice:/i);
    }
  });
});
