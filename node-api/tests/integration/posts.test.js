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
