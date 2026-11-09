const request = require('supertest');
const cheerio = require('cheerio');
const bcrypt = require('bcryptjs');
const { randomBytes, createHash } = require('node:crypto');
const { createPool } = require('../../src/db');
const { createUserRepository } = require('../../src/repositories/users');

// The PHP adapter goes through the original HTML forms, including real CSRF tokens.
function phpClient() {
  const client = request.agent(process.env.PHP_URL || 'http://localhost:8080');
  return {
    async register(input) { return this.submit('register', input); },
    async login(input) { return this.submit('login', input); },
    async submit(page, input) {
      const form = await client.get(`/?qa=${page}`).expect(200);
      const $ = cheerio.load(form.text);
      // SnowFlat also renders a header login form; select the requested action's form.
      const code = $(`[name=do${page}]`).closest('form').find('input[name=code]').val();
      expect(code).toBeTruthy();
      const response = await client.post(`/?qa=${page}`).type('form').send({ ...input, code, [`do${page}`]: '1' });
      expect([200, 302]).toContain(response.status);
      return { accepted: response.status === 302 };
    },
    async me() {
      const response = await client.get('/?qa=account').expect(200);
      const $ = cheerio.load(response.text);
      return $('.qa-logged-in').text().includes('alice');
    },
    async logout() { await client.get('/?qa=logout').expect(302); },
    async anonymous() { return (await client.get('/?qa=account')).status === 302; },
  };
}
function nodeClient() {
  const client = request.agent(process.env.API_URL || 'http://localhost:3000');
  return {
    async register(input) { return this.submit('register', input); },
    async login(input) { return this.submit('login', input); },
    async submit(action, input) {
      const response = await client.post(`/api/v1/auth/${action}`).set('X-Q2A-Request', '1').send(input);
      expect([200, 201, 400, 401, 409]).toContain(response.status);
      return { accepted: response.status < 300 };
    },
    async me() { return (await client.get('/api/v1/auth/me').expect(200)).body.user.handle === 'alice'; },
    async logout() { await client.post('/api/v1/auth/logout').set('X-Q2A-Request', '1').send({}).expect(204); },
    async anonymous() { return (await client.get('/api/v1/auth/me')).status === 401; },
  };
}

describe('PHP ↔ Node authentication parity (real HTTP and isolated MySQL databases)', () => {
  let pools;
  const suffix = randomBytes(4).toString('hex');
  const registered = { handle: `user${suffix}`, email: `${suffix}@example.test`, password: 'Password123!' };
  beforeAll(() => { pools = [createPool({ host: process.env.PHP_DB_HOST || 'php-db' }), createPool()]; });
  afterAll(async () => { await Promise.all(pools.map(pool => pool.end())); });

  test('registers the same account and initializes equivalent user/points records', async () => {
    const outcomes = [];
    for (const make of [phpClient, nodeClient]) {
      const client = make();
      outcomes.push(await client.register(registered));
      expect(await client.anonymous()).toBe(false);
    }
    expect(outcomes).toEqual([{ accepted: true }, { accepted: true }]);
    const states = [];
    for (const pool of pools) {
      const [[user]] = await pool.execute('SELECT u.*, p.points FROM qa_users u JOIN qa_userpoints p USING(userid) WHERE handle=?', [registered.handle]);
      expect(await bcrypt.compare(registered.password, user.passhash)).toBe(true);
      expect(user.passsalt).toBeNull();
      expect(user.passcheck).toBeNull();
      for (const [name, query] of [
        ['cache_userpointscount', 'SELECT COUNT(*) AS total FROM qa_userpoints'],
        ['cache_uapprovecount', 'SELECT COUNT(*) AS total FROM qa_users WHERE level<10 AND NOT(flags & 2)'],
      ]) {
        const [[count]] = await pool.query(query);
        const [[option]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [name]);
        expect(Number(option.content)).toBe(count.total);
      }
      states.push({ handle: user.handle, email: user.email, level: user.level, flags: user.flags, points: user.points });
    }
    expect(states[1]).toEqual(states[0]);
    expect(states[0]).toMatchObject({ level: 0, flags: 0, points: 100 });
  });

  test.each([
    ['duplicate handle', () => ({ ...registered, email: `other${suffix}@example.test` })],
    ['duplicate email', () => ({ ...registered, handle: `other${suffix}` })],
    ['invalid email', () => ({ ...registered, handle: `bad${suffix}`, email: 'not-an-email' })],
    ['short password', () => ({ ...registered, handle: `bad${suffix}`, email: `bad${suffix}@example.test`, password: 'short' })],
    ['invalid handle', () => ({ ...registered, handle: 'bad/name' })],
    ['missing fields', () => ({})],
  ])('rejects %s without inserting an account', async (name, input) => {
    for (const [index, make] of [phpClient, nodeClient].entries()) {
      const [[before]] = await pools[index].query('SELECT COUNT(*) AS n FROM qa_users');
      expect(await make().register(input())).toEqual({ accepted: false });
      const [[after]] = await pools[index].query('SELECT COUNT(*) AS n FROM qa_users');
      expect(after.n).toBe(before.n);
    }
  });

  test.each(['alice', 'alice@example.test', 'ALICE', ' alice '])('logs in PHP-created account using %s', async identifier => {
    for (const make of [phpClient, nodeClient]) {
      const client = make();
      expect(await client.login({ emailhandle: identifier, password: 'Password123!' })).toEqual({ accepted: true });
      expect(await client.me()).toBe(true);
      await client.logout();
      expect(await client.anonymous()).toBe(true);
    }
  });

  test.each([
    { emailhandle: 'alice', password: 'incorrect' },
    { emailhandle: 'unknown', password: 'Password123!' },
    { emailhandle: "' OR 1=1 --", password: 'Password123!' },
    { emailhandle: '', password: '' },
  ])('rejects invalid login %j', async input => {
    for (const make of [phpClient, nodeClient]) expect(await make().login(input)).toEqual({ accepted: false });
  });

  test('upgrades legacy password records after successful login', async () => {
    const salt = '0123456789abcdef';
    const hash = createHash('sha1').update(salt.slice(0, 8) + 'Password123!' + salt.slice(8)).digest();
    for (const [index, make] of [phpClient, nodeClient].entries()) {
      await pools[index].execute('UPDATE qa_users SET passhash=NULL,passsalt=?,passcheck=? WHERE handle=?', [salt, hash, 'legacy']);
      expect(await make().login({ emailhandle: 'legacy', password: 'Password123!' })).toEqual({ accepted: true });
      const [[user]] = await pools[index].query("SELECT passhash,passsalt,passcheck FROM qa_users WHERE handle='legacy'");
      expect(user.passsalt).toBeNull();
      expect(user.passcheck).toBeNull();
      expect(await bcrypt.compare('Password123!', user.passhash)).toBe(true);
    }
  });

  test('Node serializes concurrent duplicate registration', async () => {
    const input = { handle: `race${suffix}`, email: `race${suffix}@example.test`, password: 'Password123!' };
    const results = await Promise.all([nodeClient().register(input), nodeClient().register(input)]);
    expect(results.filter(x => x.accepted)).toHaveLength(1);
    const [[{ n }]] = await pools[1].execute('SELECT COUNT(*) AS n FROM qa_users WHERE handle=?', [input.handle]);
    expect(n).toBe(1);
  });

  test('Node rolls back user creation when the points write fails', async () => {
    const handle = `fail${suffix}`;
    // Inject a driver failure after the real user INSERT, within a real MySQL transaction.
    // No privileged triggers or changes to database permissions are needed.
    const repository = createUserRepository({
      async getConnection() {
        const connection = await pools[1].getConnection();
        return new Proxy(connection, {
          get(target, property) {
            if (property === 'execute') return async (sql, params) => {
              if (sql.startsWith('INSERT INTO qa_userpoints')) throw new Error('Synthetic points failure');
              return target.execute(sql, params);
            };
            return typeof target[property] === 'function' ? target[property].bind(target) : target[property];
          },
        });
      },
    });
    await expect(repository.createUser({ handle, email: `${handle}@example.test`, hash: await bcrypt.hash('Password123!', 4) }, '127.0.0.1'))
      .rejects.toThrow('Synthetic points failure');
    const [[{ n }]] = await pools[1].execute('SELECT COUNT(*) AS n FROM qa_users WHERE handle=?', [handle]);
    expect(n).toBe(0);
  });

  test('Node rejects expired sessions and remembered sessions set a persistent cookie', async () => {
    const client = request.agent(process.env.API_URL || 'http://localhost:3000');
    const response = await client.post('/api/v1/auth/login').set('X-Q2A-Request', '1')
      .send({ emailhandle: 'alice', password: 'Password123!', remember: true }).expect(200);
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain('Max-Age=2592000');
    const token = cookie.split(';')[0].split('=')[1];
    const digest = createHash('sha256').update(token).digest('hex');
    await pools[1].execute('UPDATE node_auth_sessions SET expires_at=TIMESTAMPADD(SECOND,-1,UTC_TIMESTAMP()) WHERE token_hash=?', [digest]);
    await client.get('/api/v1/auth/me').expect(401);
  });
});
