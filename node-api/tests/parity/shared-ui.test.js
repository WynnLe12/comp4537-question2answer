const request = require('supertest');
const cheerio = require('cheerio');
const { createHash, randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');

const ui = process.env.MIGRATED_UI_URL || 'http://localhost:8081';
const reference = process.env.PHP_URL || 'http://localhost:8080';

async function submit(client, action, values, token = true) {
  const page = await client.get(`/?qa=${action}`).expect(200);
  const $ = cheerio.load(page.text);
  const code = token ? $(`[name=do${action}]`).closest('form').find('[name=code]').val() : 'invalid';
  expect(code).toBeTruthy();
  return client.post(`/?qa=${action}`).type('form').send({ ...values, code, [`do${action}`]: '1' });
}

describe('Original Q2A frontend using Node authentication', () => {
  const pool = createPool();
  afterAll(() => pool.end());

  test('serves the same theme CSS and form structure as the PHP reference', async () => {
    const [original, migrated] = await Promise.all([request(reference).get('/?qa=login'), request(ui).get('/?qa=login')]);
    const a = cheerio.load(original.text), b = cheerio.load(migrated.text);
    expect(a('.qa-logo-link').text()).toBe('Question2Answer Q&A');
    expect(b('.qa-logo-link').text()).toBe(a('.qa-logo-link').text());
    const fields = $ => $('[name=dologin]').closest('form').last().find('input').map((i, el) => $(el).attr('name')).get();
    expect(fields(b)).toEqual(fields(a));
    const stylesheet = a('link[rel=stylesheet]').map((i, el) => a(el).attr('href')).get().find(href => href.includes('qa-theme/'));
    expect(stylesheet).toBeTruthy();
    const path = new URL(stylesheet, `${reference}/`).pathname;
    const [cssA, cssB] = await Promise.all([request(reference).get(path).expect(200), request(ui).get(path).expect(200)]);
    expect(cssB.text).toBe(cssA.text);
  });

  test('registers via original form, creates a Node session, persists login and revokes it', async () => {
    const client = request.agent(ui);
    const handle = `ui${randomBytes(4).toString('hex')}`;
    const result = await submit(client, 'register', { handle, email: `${handle}@example.test`, password: 'Password123!' });
    expect(result.status).toBe(302);
    expect(result.headers['x-q2a-auth-backend']).toBe('node-api-v1');
    const cookie = result.headers['set-cookie'].find(value => value.startsWith('q2a_node_bridge='));
    expect(cookie).toContain('HttpOnly');
    const token = cookie.split(';')[0].split('=')[1];
    const digest = createHash('sha256').update(token).digest('hex');
    const [[session]] = await pool.execute('SELECT u.handle FROM node_auth_sessions s JOIN qa_users u USING(userid) WHERE s.token_hash=?', [digest]);
    expect(session.handle).toBe(handle);
    const account = await client.get('/?qa=account').expect(200);
    expect(cheerio.load(account.text)('.qa-logged-in').text()).toContain(handle);
    await client.get('/?qa=logout').expect(302);
    await client.get('/?qa=account').expect(302);
    const [sessions] = await pool.execute('SELECT * FROM node_auth_sessions WHERE token_hash=?', [digest]);
    expect(sessions).toHaveLength(0);
  });

  test('login calls Node; wrong passwords and invalid CSRF do not authenticate', async () => {
    const client = request.agent(ui);
    const input = { emailhandle: 'alice', password: 'Password123!' };
    expect((await submit(client, 'login', input, false)).status).toBe(200);
    await client.get('/?qa=account').expect(302);
    const failure = await submit(client, 'login', { ...input, password: 'wrong' });
    expect(failure.status).toBe(200);
    expect(failure.text).toContain('Incorrect username/email or password.');
    await client.get('/?qa=account').expect(302);
    const success = await submit(client, 'login', input);
    expect(success.status).toBe(302);
    expect(success.headers['x-q2a-auth-backend']).toBe('node-api-v1');
    const account = await client.get('/?qa=account').expect(200);
    expect(cheerio.load(account.text)('.qa-logged-in').text()).toContain('alice');
    await client.get('/?qa=logout').expect(302);
  });
});
