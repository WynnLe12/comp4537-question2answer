const request = require('supertest');
const cheerio = require('cheerio');
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { UI_URL, siteDriver } = require('./post-helpers');

const path = '/?qa=admin/ai-usage';
const prefix = 'QA_AJAX_RESPONSE\n';
const pool = createPool();
const admin = siteDriver('admin', UI_URL, pool);
const regular = siteDriver('regular', UI_URL, pool);
const suffix = randomBytes(4).toString('hex');
let adminId;

beforeAll(async () => {
  const handle = `usagea${suffix}`;
  await admin.register(handle);
  await regular.register(`usageu${suffix}`);
  const [[user]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [handle]);
  adminId = user.userid;
  await pool.execute('UPDATE qa_users SET level=100 WHERE userid=?', [adminId]);
});

afterAll(() => pool.end());

async function loadUsage(client, code) {
  const response = await client.post('/').type('form').send({
    qa: 'ajax', qa_operation: 'ai_usage', qa_root: './', qa_request: 'admin/ai-usage', code,
  }).expect(200).expect('Cache-Control', /no-store/);
  expect(response.text.startsWith(prefix)).toBe(true);
  return JSON.parse(response.text.slice(prefix.length));
}

test.each([
  ['anonymous', request(UI_URL), 'unauthenticated'],
  ['regular', regular._client, 'no_privileges'],
])('denies the dashboard and usage relay to %s users', async (_role, client, code) => {
  const response = await client.get(path).expect(200);
  expect(cheerio.load(response.text)('.qa-ai-usage')).toHaveLength(0);
  expect(await loadUsage(client, 'invalid')).toEqual({ error: { code } });
});

test('uses the admin session to load real usage aggregates through the PHP relay', async () => {
  const page = await admin._client.get(path).expect(200).expect('Cache-Control', /no-store/);
  const $ = cheerio.load(page.text);
  expect($('.qa-ai-usage [role=status]').text()).toBe('Loading AI usage…');
  expect($('.qa-ai-usage-data').attr('hidden')).toBeDefined();
  expect($('a').filter((_i, link) => $(link).text() === 'AI Usage')).toHaveLength(1);
  const code = $('.qa-ai-usage').attr('data-code');
  expect(code).toBeTruthy();
  expect(await loadUsage(admin._client, 'invalid')).toEqual({ error: { code: 'expired_form' } });

  const baseline = await loadUsage(admin._client, code);
  const day = '2030-11-21';
  const fixtureIds = [];
  try {
    for (const [status, tokens] of [[200, 32], [502, null]]) {
      const [fixture] = await pool.execute(
        'INSERT INTO node_ai_usage (userid, endpoint, status_code, tokens_used, created_at) VALUES (?, ?, ?, ?, ?)',
        [adminId, '/api/v1/ai/evaluate', status, tokens, day],
      );
      fixtureIds.push(fixture.insertId);
    }
    const usage = await loadUsage(admin._client, code);
    expect(Object.keys(usage).sort()).toEqual([
      'byDate', 'byStatus', 'failedProviderAttempts', 'successfulEvaluations', 'totalRecordedRequests', 'totalRecordedTokens',
    ]);
    expect(usage).toMatchObject({
      totalRecordedRequests: baseline.totalRecordedRequests + 2,
      successfulEvaluations: baseline.successfulEvaluations + 1,
      failedProviderAttempts: baseline.failedProviderAttempts + 1,
      totalRecordedTokens: baseline.totalRecordedTokens + 32,
    });
    const requestsOn = (rows, field, value) => rows.find(row => row[field] === value)?.requests ?? 0;
    expect(requestsOn(usage.byDate, 'date', day)).toBe(requestsOn(baseline.byDate, 'date', day) + 2);
    for (const status of [200, 502])
      expect(requestsOn(usage.byStatus, 'statusCode', status)).toBe(requestsOn(baseline.byStatus, 'statusCode', status) + 1);
  } finally {
    for (const id of fixtureIds)
      await pool.execute('DELETE FROM node_ai_usage WHERE usage_id=?', [id]);
  }
});

test('denies a blocked administrator at both the page and relay', async () => {
  await pool.execute('UPDATE qa_users SET flags=flags|2 WHERE userid=?', [adminId]);
  try {
    const response = await admin._client.get(path).expect(200);
    expect(cheerio.load(response.text)('.qa-ai-usage')).toHaveLength(0);
    expect(await loadUsage(admin._client, 'unused')).toEqual({ error: { code: 'no_privileges' } });
  } finally {
    await pool.execute('UPDATE qa_users SET flags=flags&~2 WHERE userid=?', [adminId]);
  }
});

test('shows only the signed-in user’s usage on a separate account tab', async () => {
  const [[user]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [`usageu${suffix}`]);
  const account = cheerio.load((await regular._client.get('/?qa=account').expect(200)).text);
  const tab = account('.qa-nav-sub a').filter((_i, element) => account(element).text().trim() === 'AI Usage');
  expect(tab).toHaveLength(1);
  expect(account('.qa-main').text()).not.toContain('Recorded tokens');

  const usagePath = new URL(tab.attr('href'), UI_URL);
  const target = usagePath.pathname + usagePath.search;
  await request(UI_URL).get(target).expect(302).expect('Location', /login/);

  const readUsage = async () => {
    const response = await regular._client.get(target).expect(200).expect('Cache-Control', /no-store/);
    const $ = cheerio.load(response.text);
    expect($('h1').text().trim()).toBe('My AI API Usage');
    expect($('.qa-nav-sub .qa-nav-sub-selected').text().trim()).toBe('AI Usage');
    return $('.qa-main .qa-form-wide-static').map((_i, element) => $(element).text()).get();
  };

  const fixtureIds = [];
  try {
    for (const [userid, status, tokens] of [[adminId, 200, 900], [user.userid, 200, 42], [user.userid, 502, null]]) {
      const [fixture] = await pool.execute(
        'INSERT INTO node_ai_usage (userid, endpoint, status_code, tokens_used) VALUES (?, ?, ?, ?)',
        [userid, '/api/v1/ai/evaluate', status, tokens],
      );
      fixtureIds.push(fixture.insertId);
      if (userid === adminId) expect(await readUsage()).toEqual(['0', '0', '0', '0']);
    }
    expect(await readUsage()).toEqual(['2', '1', '1', '42']);
  } finally {
    for (const id of fixtureIds)
      await pool.execute('DELETE FROM node_ai_usage WHERE usage_id=?', [id]);
  }
});
