const request = require('supertest');
const { createApp } = require('../../src/app');
const text = require('../../src/q2a/text');
const fixtures = require('../fixtures/php-text-outputs.json');

describe('ported Q2A text helpers match PHP output', () => {
  test.each(fixtures.words)('qa_string_to_words(%j)', (input, words, tagWords) => {
    expect(text.stringToWords(input)).toEqual(words);
    expect(text.stringToWords(input, { splitideographs: false, splithyphens: false })).toEqual(tagWords);
  });
  test.each(fixtures.html)('qa_viewer_text(%j, "html")', (input, expected) => {
    expect(text.viewerText(input, 'html')).toBe(expected);
  });
  test('4-byte characters are removed and lengths count characters', () => {
    expect(text.removeUtf8mb4('a😀b')).toBe('ab');
    expect(text.strlen('café')).toBe(4);
  });
  test('qa_combine_notify_email()', () => {
    expect(text.combineNotifyEmail(5, true, '')).toBe('@');
    expect(text.combineNotifyEmail(null, true, '')).toBeNull();
    expect(text.combineNotifyEmail(null, true, 'a@b.test')).toBe('a@b.test');
    expect(text.combineNotifyEmail(5, false, 'a@b.test')).toBeNull();
  });
});

describe('posting API request handling (service replaced in these tests)', () => {
  const calls = [];
  const postService = new Proxy({}, { get: (target, name) => async request => { calls.push([name, request]); return { id: 9, type: 'Q', queued: false, cookieid: '123' }; } });
  const app = createApp({ service: {}, postService });
  test('requires the API request header and JSON', async () => {
    await request(app).post('/api/v1/questions').send({ title: 'x' }).expect(403);
  });
  test('creates and passes the path IDs, visitor cookie and address through', async () => {
    calls.length = 0;
    const response = await request(app).post('/api/v1/questions/77/answers').set('X-Q2A-Request', '1').set('Cookie', 'qa_id=555').send({ content: 'x' }).expect(201);
    expect(response.body).toEqual({ id: 9, type: 'Q', queued: false });
    expect(response.headers['set-cookie'][0]).toMatch(/^qa_id=123; .*HttpOnly/);
    expect(calls[0][0]).toBe('createAnswer');
    expect(calls[0][1]).toMatchObject({ questionid: 77, cookieid: '555', body: { content: 'x' } });
    await request(app).post('/api/v1/posts/abc/comments').set('X-Q2A-Request', '1').send({}).expect(201);
    expect(calls[1][1].parentid).toBeNull();
  });
  test('accepts posts up to 64 kB', async () => {
    await request(app).post('/api/v1/questions').set('X-Q2A-Request', '1').send({ content: 'é'.repeat(12000) }).expect(201);
  });
});

describe('flag routes (service replaced in these tests)', () => {
  const calls = [];
  const postChangeService = new Proxy({}, { get: (target, name) => async request => { calls.push([name, request]); return { id: request.postid }; } });
  const app = createApp({ service: {}, postChangeService });
  test.each([
    ['put', '/api/v1/posts/12/flag', 'flagPost'],
    ['delete', '/api/v1/posts/12/flag', 'unflagPost'],
    ['delete', '/api/v1/posts/12/flags', 'clearFlags'],
  ])('%s %s calls %s with the post ID', async (method, path, name) => {
    calls.length = 0;
    await request(app)[method](path).set('X-Q2A-Request', '1').send({}).expect(200);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(name);
    expect(calls[0][1]).toMatchObject({ postid: 12 });
  });
  test('require the API request header', async () => {
    await request(app).put('/api/v1/posts/12/flag').send({}).expect(403);
  });
});

describe('favorite routes (service replaced in these tests)', () => {
  const calls = [];
  const favoriteService = new Proxy({}, { get: (target, name) => async request => { calls.push([name, request]); return { favorite: name === 'favorite' }; } });
  const app = createApp({ service: {}, favoriteService });
  test('PUT adds and DELETE removes, passing the type and ID through', async () => {
    calls.length = 0;
    await request(app).put('/api/v1/favorites/tags/42').set('X-Q2A-Request', '1').send({}).expect(200);
    await request(app).delete('/api/v1/favorites/users/7').set('X-Q2A-Request', '1').send({}).expect(200);
    expect(calls.map(([name, req]) => [name, req.type, req.entityid])).toEqual([['favorite', 'tags', 42], ['unfavorite', 'users', 7]]);
  });
  test('require the API request header', async () => {
    await request(app).put('/api/v1/favorites/questions/1').send({}).expect(403);
  });
});

describe('favorite service checks (repository replaced)', () => {
  const { createFavoriteService } = require('../../src/services/favorites');
  const writes = [];
  const repository = { transaction: work => work({
    loadOptions: async () => ({ get: () => '10' }),
    findActor: async id => ({ userid: id }),
    favoriteCreate: async (...args) => writes.push(['create', ...args.slice(0, 3)]),
    favoriteDelete: async (...args) => writes.push(['delete', ...args]),
    userWritten: async () => {},
  }) };
  const service = createFavoriteService(repository, { identify: async token => (token ? { id: 5 } : null) });
  test('rejects anonymous users, unknown types and following yourself', async () => {
    await expect(service.favorite({ token: null, type: 'questions', entityid: 1 })).rejects.toMatchObject({ status: 401 });
    await expect(service.favorite({ token: 't', type: 'pages', entityid: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(service.favorite({ token: 't', type: 'users', entityid: 5 })).rejects.toMatchObject({ status: 403, code: 'favorite_not_allowed' });
    expect(writes).toEqual([]);
  });
  test('maps the URL type to the Q2A entity code', async () => {
    await service.favorite({ token: 't', type: 'categories', entityid: 3 });
    await service.unfavorite({ token: 't', type: 'questions', entityid: 9 });
    expect(writes).toEqual([['create', 5, 'C', 3], ['delete', 5, 'Q', 9]]);
  });
});

describe('message and wall routes (service replaced in these tests)', () => {
  const calls = [];
  const messageService = new Proxy({}, { get: (target, name) => async request => { calls.push([name, request]); return { ok: true }; } });
  const app = createApp({ service: {}, messageService });
  test('route each operation with its handle, box and ID', async () => {
    calls.length = 0;
    await request(app).post('/api/v1/users/J%C3%BCrgen%20K/messages').set('X-Q2A-Request', '1').send({ content: 'Hi' }).expect(201);
    await request(app).post('/api/v1/users/bob/wall').set('X-Q2A-Request', '1').send({ content: 'Hey' }).expect(201);
    await request(app).delete('/api/v1/wall-posts/31').set('X-Q2A-Request', '1').send({}).expect(200);
    await request(app).delete('/api/v1/messages/outbox/32').set('X-Q2A-Request', '1').send({}).expect(200);
    expect(calls.map(([name]) => name)).toEqual(['sendMessage', 'postOnWall', 'deleteWallPost', 'deleteMessage']);
    expect(calls[0][1]).toMatchObject({ handle: 'Jürgen K', body: { content: 'Hi' } });
    expect(calls[2][1].messageid).toBe(31);
    expect(calls[3][1]).toMatchObject({ box: 'outbox', messageid: 32 });
  });
  test('accept messages up to the 12000-character column', async () => {
    await request(app).post('/api/v1/users/bob/messages').set('X-Q2A-Request', '1').send({ content: 'é'.repeat(12000) }).expect(201);
  });
});

describe('message service checks (repository replaced)', () => {
  const { createMessageService } = require('../../src/services/messages');
  const service = createMessageService({ transaction: work => work({
    loadOptions: async () => ({ get: name => ({ allow_private_messages: '1', show_message_history: '1', max_rate_user_messages: '5', max_rate_ip_messages: '10' }[name] ?? ''), dbTime: 0 }),
    findActor: async () => ({ userid: 5, handle: 'me', level: 0, flags: 0 }),
    findUserByHandle: async handle => ({ userid: 6, handle, flags: handle === 'quiet' ? 16 : 0 }),
    findLimits: async () => ({}),
  }) }, { identify: async token => (token ? { id: 5 } : null) });
  test('refuse anonymous users, yourself, disabled messages and "0"', async () => {
    await expect(service.sendMessage({ token: null, handle: 'bob' })).rejects.toMatchObject({ status: 401 });
    await expect(service.sendMessage({ token: 't', handle: 'me', body: { content: 'x' } })).rejects.toMatchObject({ status: 403, code: 'no_permission' });
    await expect(service.sendMessage({ token: 't', handle: 'quiet', body: { content: 'x' } })).rejects.toMatchObject({ status: 403, code: 'messages_disabled' });
    await expect(service.sendMessage({ token: 't', handle: 'bob', body: { content: '0' } })).rejects.toMatchObject({ status: 400, code: 'validation_failed' });
    await expect(service.sendMessage({ token: 't', handle: 'bob', body: { content: 'x'.repeat(12001) } })).rejects.toMatchObject({ status: 400 });
  });
});
