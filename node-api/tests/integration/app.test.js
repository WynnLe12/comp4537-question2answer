// The app around the routes (src/app.js and src/http/): security headers, CORS for the shared UI's origin,
// request body limits per route, the health check, routes present only with their service, the 404 and
// error responses, and the small request helpers.
const request = require('supertest');
const express = require('express');
const { createApp } = require('../../src/app');
const { clientIp, postIdParam, readVisitorCookie, setVisitorCookie, MAX_POSTID } = require('../../src/http/request');
const { cookieName, cookiePath, readToken, requireApiRequest } = require('../../src/http/cookies');

const withOrigins = (origins, build) => {
  const saved = process.env.CLIENT_ORIGINS;
  if (origins === undefined) delete process.env.CLIENT_ORIGINS; else process.env.CLIENT_ORIGINS = origins;
  try { return build(); } finally { if (saved === undefined) delete process.env.CLIENT_ORIGINS; else process.env.CLIENT_ORIGINS = saved; }
};
const json = (app, path, body) => request(app).post(path).set('X-Q2A-Request', '1').set('Content-Type', 'application/json').send(body);

describe('security headers', () => {
  const app = createApp({});
  test('helmet is on and Express does not announce itself', async () => {
    const res = await request(app).get('/nothing');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'self'/);
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });
});

describe('CORS', () => {
  const app = withOrigins(' http://ui.test , http://other.test,, ', () => createApp({}));
  test.each(['http://ui.test', 'http://other.test'])('an allowed origin (%s) may call with credentials', async origin => {
    const res = await request(app).get('/api/v1/nothing').set('Origin', origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers.vary).toMatch(/Origin/);
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, X-Q2A-Request');
  });
  test('any other origin gets no CORS headers', async () => {
    for (const origin of ['http://evil.test', 'http://ui.test.evil.test', '', 'null']) {
      const res = await request(app).get('/api/v1/nothing').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });
  test('preflights: 204 for an allowed origin, 403 for any other, and passed on with no origin', async () => {
    await request(app).options('/api/v1/auth/login').set('Origin', 'http://ui.test').expect(204);
    const refused = await request(app).options('/api/v1/auth/login').set('Origin', 'http://evil.test').expect(403);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    const plain = await request(app).options('/api/v1/nothing').expect(404);
    expect(plain.body).toEqual({ error: { code: 'not_found' } });
  });
  test('a non-preflight request from a refused origin still reaches the API (the browser enforces CORS)', async () => {
    await request(app).get('/api/v1/nothing').set('Origin', 'http://evil.test').expect(404);
  });
  test('the shared UI on localhost:8081 is the default origin', async () => {
    const byDefault = withOrigins(undefined, () => createApp({}));
    const res = await request(byDefault).get('/x').set('Origin', 'http://localhost:8081');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    await request(byDefault).options('/x').set('Origin', 'http://localhost:8082').expect(403);
  });
});

describe('request bodies', () => {
  const app = createApp({});
  const sized = kb => ({ text: 'x'.repeat(kb * 1024 - 20) });
  // Body parsing happens before routing, so a path with no route shows whether the body was accepted (404)
  // or refused (413/400).
  test.each([
    ['/api/v1/auth/x', 15, 17],
    ['/api/v1/feedback', 15, 17],
    ['/api/v1/questions/x', 60, 66],
    ['/api/v1/posts/x', 60, 66],
    ['/api/v1/users/x', 60, 66],
    ['/api/v1/admin/x', 60, 66],
    ['/api/v1/ai/evaluate', 94, 98],
    ['/api/v1/internal/x', 1500, 2100],
  ])('%s accepts %i kB and refuses %i kB', async (path, ok, tooBig) => {
    await json(app, path, sized(ok)).expect(404);
    const res = await json(app, path, sized(tooBig)).expect(413);
    expect(res.body).toEqual({ error: { code: 'payload_too_large' } });
  });
  test.each(['/api/v1/auth/x', '/api/v1/posts/x', '/api/v1/ai/evaluate', '/api/v1/internal/x'])(
    '%s takes only JSON objects and arrays, and refuses malformed JSON', async path => {
      for (const body of ['"text"', '42', '{"broken":']) {
        const res = await json(app, path, body).expect(400);
        expect(res.body).toEqual({ error: { code: 'invalid_json' } });
      }
      await json(app, path, '[1]').expect(404);
    });
});

describe('health check', () => {
  test('answers ok once the health function resolves', async () => {
    let checked = 0;
    const res = await request(createApp({ health: async () => { checked++; } })).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok' });
    expect(checked).toBe(1);
  });
  test('answers 503 when the database is unreachable', async () => {
    const res = await request(createApp({ health: async () => { throw new Error('no database'); } })).get('/health').expect(503);
    expect(res.body).toEqual({ error: { code: 'service_unavailable' } });
  });
  test('the default health function needs nothing', async () => {
    await request(createApp({})).get('/health').expect(200);
  });
});

describe('routes exist only with their service', () => {
  const bare = createApp({});
  test.each([
    ['put', '/api/v1/posts/5/vote'], ['post', '/api/v1/posts/5/comments'], ['patch', '/api/v1/posts/5'], ['post', '/api/v1/posts/5/status'],
    ['post', '/api/v1/questions'], ['put', '/api/v1/questions/5/selected-answer'], ['put', '/api/v1/favorites/question/5'],
    ['post', '/api/v1/users/bob/messages'], ['delete', '/api/v1/wall-posts/5'], ['delete', '/api/v1/messages/inbox/5'],
    ['patch', '/api/v1/account'], ['post', '/api/v1/feedback'], ['patch', '/api/v1/users/bob'], ['put', '/api/v1/admin/options'],
    ['post', '/api/v1/admin/recalc'], ['post', '/api/v1/uploads'], ['post', '/api/v1/internal/reads'], ['post', '/api/v1/ai/evaluate'],
  ])('%s %s is not found without its service', async (method, path) => {
    const res = await request(bare)[method](path).set('X-Q2A-Request', '1').send({}).expect(404);
    expect(res.body).toEqual({ error: { code: 'not_found' } });
  });
  // Each service on its own mounts only its own routes.
  const only = (name, service) => createApp({ [name]: service });
  const recorder = () => new Proxy({}, { get: () => async () => ({ ok: true }) });
  test.each([
    ['voteService', 'put', '/api/v1/posts/5/vote', { vote: 1 }, 'post', '/api/v1/posts/5/comments'],
    ['postService', 'post', '/api/v1/posts/5/comments', {}, 'patch', '/api/v1/posts/5'],
    ['postChangeService', 'patch', '/api/v1/posts/5', {}, 'put', '/api/v1/posts/5/vote'],
    ['postService', 'post', '/api/v1/questions/5/answers', {}, 'post', '/api/v1/questions/5/close'],
    ['siteAdminService', 'put', '/api/v1/admin/options', {}, 'post', '/api/v1/admin/recalc'],
  ])('with only %s, %s %s works and %s %s does not', async (name, method, path, body, otherMethod, otherPath) => {
    const app = only(name, recorder());
    const res = await request(app)[method](path).set('X-Q2A-Request', '1').send(body);
    expect(res.status).not.toBe(404);
    await request(app)[otherMethod](otherPath).set('X-Q2A-Request', '1').send({}).expect(404);
  });
  test('uploads and the internal reads mount with their services', async () => {
    const app = createApp({ uploadService: {}, readPool: {}, bridgeSecret: 'secret' });
    expect((await request(app).post('/api/v1/uploads').set('X-Q2A-Request', '1').send({})).status).not.toBe(404);
    expect((await request(app).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', 'secret').send({ reads: [] })).status).not.toBe(404);
  });
});

describe('the demo shortcut and unknown paths', () => {
  const app = createApp({});
  test.each(['/demo', '/demo/'])('%s sends you to the shared UI login', async path => {
    const res = await request(app).get(path).expect(302);
    expect(res.headers.location).toBe('http://localhost:8081/?qa=login');
  });
  test('anything else is a JSON 404', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body).toEqual({ error: { code: 'not_found' } });
  });
});

describe('errors', () => {
  const failing = error => createApp({ feedbackService: { sendFeedback: async () => { throw error; } } });
  const post = app => request(app).post('/api/v1/feedback').set('X-Q2A-Request', '1').send({});
  test('a client error (4xx) passes its code and fields through', async () => {
    const res = await post(failing(Object.assign(new Error('x'), { status: 422, code: 'validation_failed', fields: { email: 'invalid' } }))).expect(422);
    expect(res.body).toEqual({ error: { code: 'validation_failed', fields: { email: 'invalid' } } });
  });
  test.each([400, 403, 404, 429, 499])('status %i is passed through', async status => {
    const res = await post(failing({ status, code: 'c' })).expect(status);
    expect(res.body).toEqual({ error: { code: 'c' } });
  });
  test.each([[500], [503], [399], [302], ['400'], [400.5], [undefined]])('status %j becomes 503 with no details', async status => {
    const res = await post(failing({ status, code: 'secret_detail', fields: { a: 1 } })).expect(503);
    expect(res.body).toEqual({ error: { code: 'service_unavailable' } });
  });
  test('unexpected errors are logged outside tests; client errors and parse errors are not', async () => {
    const saved = process.env.NODE_ENV;
    const logged = [];
    const spy = jest.spyOn(console, 'error').mockImplementation(error => logged.push(error));
    try {
      process.env.NODE_ENV = 'production';
      const crash = new Error('database down');
      await post(failing(crash)).expect(503);
      await post(failing({ status: 400, code: 'c' })).expect(400);
      await post(failing({ status: 500, type: 'entity.verify.failed' })).expect(503);
      await json(createApp({}), '/api/v1/auth/x', '{bad').expect(400);
      expect(logged).toEqual([crash]);
      process.env.NODE_ENV = 'test';
      await post(failing(new Error('quiet in tests'))).expect(503);
      expect(logged).toEqual([crash]);
    } finally {
      spy.mockRestore();
      process.env.NODE_ENV = saved;
    }
  });
});

describe('request helpers', () => {
  test('clientIp() unwraps IPv4-mapped IPv6 addresses only', () => {
    expect(clientIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientIp('::ffff:abcd')).toBe('::ffff:abcd');
    expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp('1.2.3.4')).toBe('1.2.3.4');
    expect(clientIp(undefined)).toBeUndefined();
  });
  test('postIdParam() takes 1 to 4294967295 written as up to ten digits', () => {
    expect(MAX_POSTID).toBe(4294967295);
    expect([postIdParam('1'), postIdParam('0042'), postIdParam('4294967295')]).toEqual([1, 42, 4294967295]);
    for (const bad of ['0', '4294967296', '9999999999', '12345678901', '-1', '1.5', '1e3', ' 1', '1 ', '', 'x1', '0x10', undefined]) expect(postIdParam(bad)).toBeNull();
  });
  test('readVisitorCookie() finds qa_id among other cookies', () => {
    const req = cookie => ({ headers: { cookie } });
    expect(readVisitorCookie(req('a=1; qa_id=123; b=2'))).toBe('123');
    expect(readVisitorCookie(req('qa_id=7'))).toBe('7');
    expect(readVisitorCookie(req('xqa_id=1; qa_idx=2'))).toBeNull();
    expect(readVisitorCookie(req(undefined))).toBeNull();
  });
  test('setVisitorCookie() sets nothing without an ID', () => {
    const set = [];
    setVisitorCookie({ cookie: (...args) => set.push(args) }, null, true);
    setVisitorCookie({ cookie: (...args) => set.push(args) }, '', true);
    expect(set).toEqual([]);
    setVisitorCookie({ cookie: (...args) => set.push(args) }, '9', 1);
    expect(set).toEqual([['qa_id', '9', { maxAge: 31536000000, path: '/', httpOnly: true, secure: true, sameSite: 'lax' }]]);
  });
  test('readToken() finds the session cookie', () => {
    expect([cookieName, cookiePath]).toEqual(['q2a_node_session', '/api/v1']);
    expect(readToken({ headers: { cookie: 'qa_id=1; q2a_node_session=abc.def' } })).toBe('abc.def');
    expect(readToken({ headers: { cookie: 'q2a_node_sessionx=1' } })).toBeUndefined();
    expect(readToken({ headers: {} })).toBeUndefined();
  });
  test('requireApiRequest() lets reads through and needs the header and JSON for writes', async () => {
    const app = express();
    app.use(requireApiRequest);
    app.all('/', (req, res) => res.json({ ok: true }));
    for (const method of ['get', 'head']) {
      const res = await request(app)[method]('/').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
    }
    for (const method of ['post', 'put', 'patch', 'delete']) {
      await request(app)[method]('/').set('X-Q2A-Request', '1').set('Content-Type', 'application/json').send('{}').expect(200);
      const refused = await request(app)[method]('/').set('Content-Type', 'application/json').send('{}').expect(403);
      expect(refused.headers['cache-control']).toBe('no-store');
      await request(app)[method]('/').set('X-Q2A-Request', '1').set('Content-Type', 'text/plain').send('{}').expect(403);
    }
  });
});
