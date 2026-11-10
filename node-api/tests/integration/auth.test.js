const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const { createApp } = require('../../src/app');
const { createAuthService, registrationInput, verifyPassword } = require('../../src/services/auth');
const jwtSecret = 'test-only-q2a-jwt-signing-secret-not-for-production';

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
    app = createApp({ service: createAuthService(repository, { jwtSecret }) });
  });
  function post(client, path, body) { return client.post(`/api/v1/auth/${path}`).set('X-Q2A-Request', '1').send(body); }

  test('login establishes an HttpOnly session; logout revokes it', async () => {
    const client = request.agent(app);
    await client.get('/api/v1/auth/me').expect(401);
    const response = await post(client, 'login', { emailhandle: 'alice', password: 'Password123!' }).expect(200);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(response.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
    expect(response.body.user).not.toHaveProperty('passhash');
    const token = response.headers['set-cookie'][0].split(';')[0].split('=')[1];
    expect(jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer: 'q2a-node-api', audience: 'q2a-auth' }))
      .toMatchObject({ sub: '1', iss: 'q2a-node-api', aud: 'q2a-auth' });
    expect((await client.get('/api/v1/auth/me').expect(200)).body.user.handle).toBe('alice');
    const oldCookie = response.headers['set-cookie'][0].split(';')[0];
    await post(client, 'logout', {}).expect(204);
    await request(app).get('/api/v1/auth/me').set('Cookie', oldCookie).expect(401);
  });
  test('rejects tampered, expired and wrong-audience JWTs before database lookup', async () => {
    const response = await post(request(app), 'login', { emailhandle: 'alice', password: 'Password123!' }).expect(200);
    const token = response.headers['set-cookie'][0].split(';')[0].split('=')[1];
    const invalid = [
      token.slice(0, -10) + (token.at(-10) === 'a' ? 'b' : 'a') + token.slice(-9),
      jwt.sign({}, jwtSecret, { algorithm: 'HS256', issuer: 'q2a-node-api', audience: 'q2a-auth', subject: '1', jwtid: 'a'.repeat(32), expiresIn: -1 }),
      jwt.sign({}, jwtSecret, { algorithm: 'HS256', issuer: 'q2a-node-api', audience: 'other', subject: '1', jwtid: 'a'.repeat(32), expiresIn: 60 }),
    ];
    repository.findSession.mockClear();
    for (const value of invalid) {
      await request(app).get('/api/v1/auth/me').set('Cookie', `q2a_node_session=${value}`).expect(401);
    }
    expect(repository.findSession).not.toHaveBeenCalled();
  });
  test('registration automatically authenticates', async () => {
    const client = request.agent(app);
    await post(client, 'register', { handle: 'alice', email: 'alice@example.test', password: 'Password123!' }).expect(201);
    await client.get('/api/v1/auth/me').expect(200);
  });
  test('configured bcrypt cost applies to registration and login upgrades', async () => {
    const service = createAuthService(repository, { jwtSecret, saltRounds: 5 });
    await service.register({ handle: 'alice', email: 'alice@example.test', password: 'Password123!' }, '127.0.0.1');
    const registeredHash = repository.createUser.mock.calls[0][0].hash;
    expect(bcrypt.getRounds(registeredHash)).toBe(5);
    expect(await bcrypt.compare('Password123!', registeredHash)).toBe(true);
    await service.login({ emailhandle: 'alice', password: 'Password123!' }, '127.0.0.1');
    const upgradedHash = repository.upgradePassword.mock.calls[0][1];
    expect(bcrypt.getRounds(upgradedHash)).toBe(5);
    expect(await bcrypt.compare('Password123!', upgradedHash)).toBe(true);
    alice.passhash = upgradedHash;
    repository.upgradePassword.mockClear();
    await service.login({ emailhandle: 'alice', password: 'Password123!' }, '127.0.0.1');
    expect(repository.upgradePassword).not.toHaveBeenCalled();
  });
  test.each([0, 3, 32, 5.5, NaN])('rejects invalid bcrypt cost %s', saltRounds => {
    expect(() => createAuthService(repository, { jwtSecret, saltRounds })).toThrow('BCRYPT_SALT_ROUNDS');
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
    app = createApp({ service: createAuthService(repository, { jwtSecret }), rateLimitMax: 1 });
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
