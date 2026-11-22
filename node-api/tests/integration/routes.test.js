// Every v1 route, with the services replaced by recorders: each route must call the right service method
// with the session token, the visitor cookie, the client's IP, the IDs from the path (as numbers, or null
// when they cannot name anything) and the body, answer with the right status, and refuse writes that do
// not carry the API request header (the cross-site request guard).
const request = require('supertest');
const { createApp } = require('../../src/app');

const calls = [];
const results = {
  createQuestion: { id: 9, type: 'Q', queued: false, cookieid: '456' },
  createAnswer: { id: 10, type: 'A', queued: true, cookieid: null },
  createComment: { id: 11, type: 'C', queued: false, cookieid: '789' },
  login: { token: 'tok-login', remember: false, ttl: 60, user: { userid: 1 } },
  register: { token: 'tok-register', remember: true, ttl: 60, user: { userid: 2 } },
  finishPasswordReset: { token: 'tok-reset', remember: true, ttl: 120, user: { userid: 3 } },
  me: { userid: 1 },
};
const recorder = name => new Proxy({}, {
  get: (target, method) => async (...args) => {
    calls.push({ service: name, method, args });
    return results[method] ?? { called: method };
  },
});
const services = Object.fromEntries(['service', 'voteService', 'postService', 'postChangeService', 'favoriteService', 'messageService',
  'accountService', 'feedbackService', 'userAdminService', 'siteAdminService', 'recalcService'].map(name => [name, recorder(name)]));
const app = createApp({ ...services, rateLimitMax: 1000 });

const SESSION = 'q2a_node_session=tok-123; qa_id=555';
const IP = expect.stringMatching(/^(127\.0\.0\.1|::1)$/); // supertest's loopback address, IPv4-mapped form unwrapped
const lastCall = () => calls.at(-1);
const send = (method, path, body, headers = {}) => {
  let req = request(app)[method](path).set('Cookie', SESSION);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return body === undefined ? req : req.set('X-Q2A-Request', '1').send(body);
};
beforeEach(() => { calls.length = 0; });

// [method, path, service, service method, the request the service must receive, status]
const common = { token: 'tok-123', ip: IP };
const withVisitor = { ...common, cookieid: '555' };
const ROUTES = [
  ['put', '/api/v1/posts/5/vote', 'voteService', 'vote', { ...common, postid: 5, vote: 1 }, 200, { vote: 1 }],
  ['patch', '/api/v1/posts/5', 'postChangeService', 'editPost', { ...withVisitor, postid: 5, body: { content: 'x' } }],
  ['post', '/api/v1/posts/5/status', 'postChangeService', 'setStatus', { ...withVisitor, postid: 5, body: { content: 'x' } }],
  ['delete', '/api/v1/posts/5', 'postChangeService', 'deletePost', { ...withVisitor, postid: 5 }],
  ['post', '/api/v1/posts/5/claim', 'postChangeService', 'claimPost', { ...withVisitor, postid: 5 }],
  ['put', '/api/v1/posts/5/flag', 'postChangeService', 'flagPost', { ...withVisitor, postid: 5 }],
  ['delete', '/api/v1/posts/5/flag', 'postChangeService', 'unflagPost', { ...withVisitor, postid: 5 }],
  ['delete', '/api/v1/posts/5/flags', 'postChangeService', 'clearFlags', { ...withVisitor, postid: 5 }],
  ['put', '/api/v1/questions/7/selected-answer', 'postChangeService', 'selectAnswer', { ...withVisitor, questionid: 7, body: { content: 'x' } }],
  ['post', '/api/v1/questions/7/close', 'postChangeService', 'closeQuestion', { ...withVisitor, questionid: 7 }],
  ['delete', '/api/v1/questions/7/close', 'postChangeService', 'reopenQuestion', { ...withVisitor, questionid: 7 }],
  ['put', '/api/v1/favorites/question/7', 'favoriteService', 'favorite', { ...common, type: 'question', entityid: 7 }],
  ['delete', '/api/v1/favorites/user/8', 'favoriteService', 'unfavorite', { ...common, type: 'user', entityid: 8 }],
  ['post', '/api/v1/users/bob/messages', 'messageService', 'sendMessage', { ...common, handle: 'bob', body: { content: 'x' } }, 201],
  ['post', '/api/v1/users/bob/wall', 'messageService', 'postOnWall', { ...common, handle: 'bob', body: { content: 'x' } }, 201],
  ['delete', '/api/v1/wall-posts/9', 'messageService', 'deleteWallPost', { ...common, messageid: 9 }],
  ['delete', '/api/v1/messages/inbox/9', 'messageService', 'deleteMessage', { ...common, box: 'inbox', messageid: 9 }],
  ['patch', '/api/v1/account', 'accountService', 'saveProfile', { ...common, body: { content: 'x' } }],
  ['put', '/api/v1/account/password', 'accountService', 'changePassword', { ...common, body: { content: 'x' } }],
  ['post', '/api/v1/account/confirmation-email', 'accountService', 'sendConfirmation', common],
  ['post', '/api/v1/account/confirm-email', 'accountService', 'confirmEmail', common],
  ['post', '/api/v1/account/password-reset', 'accountService', 'startPasswordReset', common],
  ['post', '/api/v1/account/unsubscribe', 'accountService', 'unsubscribe', common],
  ['patch', '/api/v1/users/bob', 'userAdminService', 'editUser', { ...common, handle: 'bob', body: { content: 'x' } }],
  ['delete', '/api/v1/users/bob', 'userAdminService', 'deleteUser', { ...common, handle: 'bob' }],
  ['put', '/api/v1/users/bob/level', 'userAdminService', 'changeLevel', { ...common, handle: 'bob' }],
  ['post', '/api/v1/users/bob/approve', 'userAdminService', 'approveUser', { ...common, handle: 'bob' }],
  ['put', '/api/v1/users/bob/block', 'userAdminService', 'blockUser', { ...common, handle: 'bob' }],
  ['delete', '/api/v1/users/bob/block', 'userAdminService', 'unblockUser', { ...common, handle: 'bob' }],
  ['post', '/api/v1/users/bob/hide-posts', 'userAdminService', 'hidePosts', { ...common, handle: 'bob' }],
  ['put', '/api/v1/admin/options', 'siteAdminService', 'saveOptions', { ...common, host: expect.stringMatching(/^127\.0\.0\.1:\d+$/), body: { content: 'x' } }],
  ['post', '/api/v1/admin/options/reset', 'siteAdminService', 'resetOptions', common],
  ['post', '/api/v1/admin/recalc', 'recalcService', 'perform', { ...common, body: { content: 'x' } }],
  ['post', '/api/v1/admin/mailing/test', 'siteAdminService', 'mailingTest', common],
  ['post', '/api/v1/admin/mailing/start', 'siteAdminService', 'mailingStart', common],
  ['post', '/api/v1/admin/mailing/stop', 'siteAdminService', 'mailingStop', common],
  ['post', '/api/v1/admin/mailing/step', 'siteAdminService', 'mailingStep', common],
  ['put', '/api/v1/admin/plugins', 'siteAdminService', 'setEnabledPlugins', common],
  ['post', '/api/v1/admin/categories', 'siteAdminService', 'saveCategory', common],
  ['put', '/api/v1/admin/categories/4', 'siteAdminService', 'saveCategory', { ...common, body: { content: 'x', categoryid: 4 } }],
  ['delete', '/api/v1/admin/categories/4', 'siteAdminService', 'deleteCategory', { ...common, params: { categoryid: '4' } }],
  ['post', '/api/v1/admin/categories/4/reassign', 'siteAdminService', 'reassignCategory', { ...common, params: { categoryid: '4' } }],
  ['post', '/api/v1/admin/pages', 'siteAdminService', 'savePage', common],
  ['put', '/api/v1/admin/pages/3', 'siteAdminService', 'savePage', { ...common, body: { content: 'x', pageid: 3 } }],
  ['delete', '/api/v1/admin/pages/3', 'siteAdminService', 'deletePage', { ...common, params: { pageid: '3' } }],
  ['post', '/api/v1/admin/widgets', 'siteAdminService', 'saveWidget', common],
  ['put', '/api/v1/admin/widgets/2', 'siteAdminService', 'saveWidget', { ...common, body: { content: 'x', widgetid: 2 } }],
  ['delete', '/api/v1/admin/widgets/2', 'siteAdminService', 'deleteWidget', { ...common, params: { widgetid: '2' } }],
  ['post', '/api/v1/admin/user-titles', 'siteAdminService', 'saveUserTitle', common],
  ['post', '/api/v1/admin/user-fields', 'siteAdminService', 'saveUserField', common],
  ['put', '/api/v1/admin/user-fields/6', 'siteAdminService', 'saveUserField', { ...common, body: { content: 'x', fieldid: 6 } }],
  ['delete', '/api/v1/admin/user-fields/6', 'siteAdminService', 'deleteUserField', { ...common, params: { fieldid: '6' } }],
  ['post', '/api/v1/feedback', 'feedbackService', 'sendFeedback', { ...common, body: { content: 'x' } }],
];

describe.each(ROUTES)('%s %s', (method, path, service, serviceMethod, expected, status = 200, body = { content: 'x' }) => {
  test(`calls ${service}.${serviceMethod}() with the request`, async () => {
    const res = await send(method, path, body).expect(status);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(calls).toHaveLength(1);
    expect(lastCall()).toMatchObject({ service, method: serviceMethod });
    expect(lastCall().args[0]).toEqual(expect.objectContaining(expected));
    expect(res.body).toEqual({ called: serviceMethod });
  });
  test('refuses a write without the API request header', async () => {
    const res = await request(app)[method](path).set('Cookie', SESSION).set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(403);
    expect(res.body).toEqual({ error: { code: 'request_not_allowed' } });
    expect(calls).toHaveLength(0);
  });
  test('refuses a write that is not JSON', async () => {
    await request(app)[method](path).set('Cookie', SESSION).set('X-Q2A-Request', '1').set('Content-Type', 'text/plain').send('x').expect(403);
    expect(calls).toHaveLength(0);
  });
});

describe('IDs in the path', () => {
  test.each([['abc', null], ['0', null], ['4294967295', 4294967295], ['4294967296', null], ['12345678901', null], ['-3', null], ['007', 7]])(
    'post %s is passed on as %j', async (id, expected) => {
      await send('patch', `/api/v1/posts/${id}`, {}).expect(200);
      expect(lastCall().args[0].postid).toBe(expected);
    });
});

describe('votes', () => {
  test.each([[-1], [0], [1]])('a vote of %j is passed on', async vote => {
    await send('put', '/api/v1/posts/5/vote', { vote }).expect(200);
    expect(lastCall().args[0].vote).toBe(vote);
  });
  test.each([[2], [-2], ['1'], [null], [true], [undefined]])('a vote of %j is refused before the service', async vote => {
    const res = await send('put', '/api/v1/posts/5/vote', vote === undefined ? {} : { vote }).expect(400);
    expect(res.body).toEqual({ error: { code: 'invalid_input', fields: { vote: 'invalid' } } });
    expect(calls).toHaveLength(0);
  });
});

describe('creating posts', () => {
  test.each([
    ['post', '/api/v1/questions', 'createQuestion', {}, { id: 9, type: 'Q', queued: false }, '456'],
    ['post', '/api/v1/questions/7/answers', 'createAnswer', { questionid: 7 }, { id: 10, type: 'A', queued: true }, null],
    ['post', '/api/v1/posts/5/comments', 'createComment', { parentid: 5 }, { id: 11, type: 'C', queued: false }, '789'],
  ])('%s %s', async (method, path, serviceMethod, ids, response, cookieid) => {
    const res = await send(method, path, { title: 't' }).expect(201);
    expect(lastCall()).toMatchObject({ service: 'postService', method: serviceMethod });
    expect(lastCall().args[0]).toEqual({ ...withVisitor, ...ids, body: { title: 't' } });
    expect(res.body).toEqual(response); // the new visitor cookie is not in the body
    const cookie = (res.headers['set-cookie'] ?? []).find(c => c.startsWith('qa_id='));
    if (cookieid) {
      // qa_cookie_get_create(): a year, the whole site, HttpOnly
      expect(cookie).toMatch(new RegExp(`^qa_id=${cookieid}; Max-Age=31536000; Path=/; Expires=.+; HttpOnly; SameSite=Lax$`));
    } else {
      expect(cookie).toBeUndefined();
    }
  });
  test('the visitor cookie is Secure when the API runs on HTTPS', async () => {
    const secure = createApp({ ...services, secureCookies: true });
    const res = await request(secure).post('/api/v1/questions').set('X-Q2A-Request', '1').send({}).expect(201);
    expect(res.headers['set-cookie'].find(c => c.startsWith('qa_id='))).toMatch(/; Secure;/);
    expect(lastCall().args[0].cookieid).toBeNull(); // no visitor cookie sent
  });
});

describe('sessions', () => {
  test('login sets an HttpOnly, SameSite=Strict session cookie for the API only, ending with the browser session', async () => {
    const res = await send('post', '/api/v1/auth/login', { handle: 'a' }).expect(200);
    expect(lastCall()).toMatchObject({ service: 'service', method: 'login', args: [{ handle: 'a' }, expect.any(String)] });
    expect(res.body).toEqual({ user: { userid: 1 } });
    expect(res.headers['set-cookie']).toEqual(['q2a_node_session=tok-login; Path=/api/v1; HttpOnly; SameSite=Strict']);
  });
  test('registering with "remember me" keeps the cookie for the session lifetime', async () => {
    const res = await send('post', '/api/v1/auth/register', { handle: 'b' }).expect(201);
    expect(lastCall()).toMatchObject({ method: 'register', args: [{ handle: 'b' }, expect.any(String)] });
    expect(res.body).toEqual({ user: { userid: 2 } });
    expect(res.headers['set-cookie'][0]).toMatch(/^q2a_node_session=tok-register; Max-Age=60; Path=\/api\/v1; Expires=.+; HttpOnly; SameSite=Strict$/);
  });
  test('finishing a password reset signs the user in the same way', async () => {
    const res = await send('post', '/api/v1/account/password-reset/complete', { code: 'c' }).expect(200);
    expect(lastCall()).toMatchObject({ service: 'accountService', method: 'finishPasswordReset' });
    expect(lastCall().args[0]).toEqual({ ...common, body: { code: 'c' } });
    expect(res.body).toEqual({ user: { userid: 3 } });
    expect(res.headers['set-cookie'][0]).toMatch(/^q2a_node_session=tok-reset; Max-Age=120; Path=\/api\/v1; Expires=.+; HttpOnly; SameSite=Strict$/);
  });
  test('the session cookie is Secure on HTTPS', async () => {
    const secure = createApp({ ...services, secureCookies: true });
    const res = await request(secure).post('/api/v1/auth/login').set('X-Q2A-Request', '1').send({}).expect(200);
    expect(res.headers['set-cookie'][0]).toMatch(/; Secure;/);
    const reset = await request(secure).post('/api/v1/account/password-reset/complete').set('X-Q2A-Request', '1').send({}).expect(200);
    expect(reset.headers['set-cookie'][0]).toMatch(/; Secure;/);
  });
  test('a login with no body passes an empty object', async () => {
    await request(app).post('/api/v1/auth/login').set('X-Q2A-Request', '1').set('Content-Type', 'application/json').expect(200);
    expect(lastCall().args[0]).toEqual({});
  });
  test('me reads the session cookie and needs no request header', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', SESSION).expect(200);
    expect(lastCall()).toMatchObject({ method: 'me', args: ['tok-123'] });
    expect(res.body).toEqual({ user: { userid: 1 } });
    expect(res.headers['cache-control']).toBe('no-store');
  });
  test('logout ends the session and clears the cookie', async () => {
    const res = await send('post', '/api/v1/auth/logout', {}).expect(204);
    expect(lastCall()).toMatchObject({ method: 'logout', args: ['tok-123'] });
    expect(res.headers['set-cookie'][0]).toMatch(/^q2a_node_session=; Path=\/api\/v1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict$/);
  });
  test('logins and registrations are rate limited with standard headers only', async () => {
    const limited = createApp({ ...services, rateLimitMax: 2 });
    for (let i = 0; i < 2; i++) await request(limited).post('/api/v1/auth/login').set('X-Q2A-Request', '1').send({}).expect(200);
    const res = await request(limited).post('/api/v1/auth/register').set('X-Q2A-Request', '1').send({}).expect(429);
    expect(res.body).toEqual({ error: { code: 'rate_limited' } });
    expect(res.headers.ratelimit).toMatch(/r=0/);
    expect(res.headers['ratelimit-policy']).toMatch(/q=2; w=3600/);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    // me and logout are not limited
    await request(limited).get('/api/v1/auth/me').expect(200);
  });
});

describe('image uploads (the image is the body)', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  test.each([
    ['/api/v1/account/avatar', 'accountService', 'uploadAvatar'],
    ['/api/v1/admin/default-avatar', 'siteAdminService', 'uploadDefaultAvatar'],
  ])('PUT %s passes the image bytes on', async (path, service, serviceMethod) => {
    const res = await request(app).put(path).set('Cookie', SESSION).set('X-Q2A-Request', '1').set('Content-Type', 'image/png').send(png).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(lastCall()).toMatchObject({ service, method: serviceMethod });
    expect(lastCall().args[0]).toEqual({ ...common, image: png });
  });
  test.each([
    ['/api/v1/account/avatar'], ['/api/v1/admin/default-avatar'],
  ])('PUT %s refuses requests without the header or that are not images', async path => {
    for (const [header, type] of [[null, 'image/png'], ['1', 'application/json'], ['0', 'image/png']]) {
      let req = request(app).put(path).set('Content-Type', type);
      if (header) req = req.set('X-Q2A-Request', header);
      const res = await req.send(type === 'application/json' ? '{}' : png).expect(403);
      expect(res.body).toEqual({ error: { code: 'request_not_allowed' } });
      expect(res.headers['cache-control']).toBe('no-store');
    }
    expect(calls).toHaveLength(0);
  });
  test('images over 2 MB are refused', async () => {
    const res = await request(app).put('/api/v1/account/avatar').set('X-Q2A-Request', '1').set('Content-Type', 'image/png').send(Buffer.alloc(2 * 1024 * 1024 + 1)).expect(413);
    expect(res.body).toEqual({ error: { code: 'payload_too_large' } });
  });
  test('an image just under 2 MB is accepted', async () => {
    await request(app).put('/api/v1/admin/default-avatar').set('X-Q2A-Request', '1').set('Content-Type', 'image/jpeg').send(Buffer.alloc(2 * 1024 * 1024 - 10)).expect(200);
    expect(lastCall().args[0].image).toHaveLength(2 * 1024 * 1024 - 10);
  });
});

describe('feedback', () => {
  test('the browser comes from the body when given, otherwise from the User-Agent', async () => {
    await send('post', '/api/v1/feedback', { message: 'hi', browser: 'Bridged/2' }, { 'User-Agent': 'Direct/1' }).expect(200);
    expect(lastCall().args[0]).toEqual({ ...common, body: { message: 'hi', browser: 'Bridged/2' }, browser: 'Bridged/2' });
    await send('post', '/api/v1/feedback', { message: 'hi', browser: 5 }, { 'User-Agent': 'Direct/1' }).expect(200);
    expect(lastCall().args[0].browser).toBe('Direct/1');
  });
});

describe('GET needs no request header; other methods do', () => {
  test('GET /api/v1/admin/ai/usage', async () => {
    const res = await request(app).get('/api/v1/admin/ai/usage').set('Cookie', SESSION).expect(200);
    expect(lastCall()).toMatchObject({ service: 'siteAdminService', method: 'getAiUsage' });
    expect(lastCall().args[0]).toEqual(expect.objectContaining(common));
    expect(res.headers['cache-control']).toBe('no-store');
  });
  test('HEAD is treated as a read', async () => {
    await request(app).head('/api/v1/auth/me').expect(200);
  });
  test('the header must be exactly 1', async () => {
    await request(app).post('/api/v1/feedback').set('X-Q2A-Request', 'true').send({}).expect(403);
  });
});

describe('client IP', () => {
  test('a forwarded address is believed only from a trusted proxy, and IPv4-mapped addresses are unwrapped', async () => {
    const trusting = createApp({ ...services, trustProxy: 'loopback' });
    await request(trusting).post('/api/v1/feedback').set('X-Q2A-Request', '1').set('X-Forwarded-For', '::ffff:9.9.9.9').send({}).expect(200);
    expect(lastCall().args[0].ip).toBe('9.9.9.9');
    await request(trusting).post('/api/v1/feedback').set('X-Q2A-Request', '1').set('X-Forwarded-For', '2001:db8::1').send({}).expect(200);
    expect(lastCall().args[0].ip).toBe('2001:db8::1');
    await request(app).post('/api/v1/feedback').set('X-Q2A-Request', '1').set('X-Forwarded-For', '9.9.9.9').send({}).expect(200);
    expect(lastCall().args[0].ip).toEqual(IP);
  });
});
