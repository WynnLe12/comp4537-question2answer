const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createHash } = require('node:crypto');
const { createApp } = require('../../src/app');
const { createAuthService, registrationInput, verifyPassword } = require('../../src/services/auth');

describe('API authentication contract (repository replaced in these tests)', () => {
  let app, repository, alice;
  beforeEach(async () => {
    alice = { userid: 1, handle: 'alice', email: 'alice@example.test', level: 0, flags: 0, passhash: await bcrypt.hash('Password123!', 4) };
    const sessions = new Map();
    repository = {
      find: jest.fn(async (field, value) => alice[field] === value ? [alice] : []),
      upgradePassword: jest.fn(async () => {}),
      createUser: jest.fn(async input => ({ ...alice, handle: input.handle, email: input.email })),
      createSession: jest.fn(async (id, hash) => sessions.set(hash, alice)),
      findSession: jest.fn(async hash => sessions.get(hash)),
      deleteSession: jest.fn(async hash => sessions.delete(hash)),
    };
    app = createApp({ service: createAuthService(repository) });
  });
  function post(client, path, body) { return client.post(`/api/v1/auth/${path}`).set('X-Q2A-Request', '1').send(body); }

  test('login establishes an HttpOnly session; logout revokes it', async () => {
    const client = request.agent(app);
    await client.get('/api/v1/auth/me').expect(401);
    const response = await post(client, 'login', { emailhandle: 'alice', password: 'Password123!' }).expect(200);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(response.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    expect(response.body.user).not.toHaveProperty('passhash');
    expect((await client.get('/api/v1/auth/me').expect(200)).body.user.handle).toBe('alice');
    const oldCookie = response.headers['set-cookie'][0].split(';')[0];
    await post(client, 'logout', {}).expect(204);
    await request(app).get('/api/v1/auth/me').set('Cookie', oldCookie).expect(401);
  });
  test('registration automatically authenticates', async () => {
    const client = request.agent(app);
    await post(client, 'register', { handle: 'alice', email: 'alice@example.test', password: 'Password123!' }).expect(201);
    await client.get('/api/v1/auth/me').expect(200);
  });
  test('wrong passwords and unknown accounts have the same public error', async () => {
    const wrong = await post(request(app), 'login', { emailhandle: 'alice', password: 'incorrect' }).expect(401);
    const missing = await post(request(app), 'login', { emailhandle: 'missing', password: 'incorrect' }).expect(401);
    expect(wrong.body).toEqual(missing.body);
    expect(repository.createSession).not.toHaveBeenCalled();
  });
  test('rejects cross-site form requests, malformed JSON and oversized bodies', async () => {
    await request(app).post('/api/v1/auth/login').send({}).expect(403);
    await request(app).post('/api/v1/auth/login').set('X-Q2A-Request', '1').type('form').send({ password: 'x' }).expect(403);
    await request(app).post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{').expect(400);
    await post(request(app), 'login', { password: 'a'.repeat(20000) }).expect(413);
  });
  test('rejects object-valued credentials and conceals database errors', async () => {
    await post(request(app), 'login', { emailhandle: {}, password: 'Password123!' }).expect(400);
    repository.find.mockRejectedValue(new Error('secret SQL connection details'));
    const response = await post(request(app), 'login', { emailhandle: 'alice', password: 'Password123!' }).expect(503);
    expect(response.text).not.toContain('secret');
  });
  test('rate limits authentication attempts', async () => {
    app = createApp({ service: createAuthService(repository), rateLimitMax: 1 });
    await post(request(app), 'login', {}).expect(400);
    await post(request(app), 'login', {}).expect(429);
  });
  test('unversioned and unsupported version routes do not expose authentication', async () => {
    await request(app).post('/api/auth/login').send({}).expect(404);
    await request(app).post('/api/v2/auth/login').send({}).expect(404);
  });
});

describe('Q2A password and input compatibility', () => {
  test('verifies legacy salted SHA-1 and requests an upgrade', async () => {
    const salt = '0123456789abcdef';
    const passcheck = createHash('sha1').update(salt.slice(0, 8) + 'Password123!' + salt.slice(8)).digest();
    const user = { passsalt: Buffer.from(salt), passcheck };
    expect(await verifyPassword(user, 'Password123!')).toEqual({ valid: true, rehash: true });
    expect((await verifyPassword(user, 'wrong')).valid).toBe(false);
  });
  test('accepts PHP bcrypt $2y$ hashes', async () => {
    const hash = (await bcrypt.hash('Password123!', 10)).replace('$2b$', '$2y$');
    expect(await verifyPassword({ passhash: hash }, 'Password123!')).toEqual({ valid: true, rehash: false });
  });
  test('preserves PHP trimming, newline normalization and handle sanitization', () => {
    const input = registrationInput({ handle: '  a\u200Bb😀  ', email: ' test@example.test ', password: '  abc\r\ndefgh  ' });
    expect(input).toEqual({ handle: 'ab', email: 'test@example.test', password: 'abc\ndefgh' });
  });
  test.each(['', '.', '..', 'bad@name', 'bad/name', 'bad+name', 'x'.repeat(21), 'anonymous'])('rejects invalid handle %j', handle => {
    expect(() => registrationInput({ handle, email: 'test@example.test', password: 'Password123!' })).toThrow();
  });
});
