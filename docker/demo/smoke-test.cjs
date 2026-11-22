const assert = require('node:assert/strict');
const test = require('node:test');

function httpsOrigin(name) {
  const url = new URL(process.env[name]);
  assert.equal(url.protocol, 'https:', `${name} must use HTTPS`);
  return url.origin;
}

const ui = httpsOrigin('DEMO_TEST_UI_ORIGIN');
const api = httpsOrigin('DEMO_TEST_API_ORIGIN');
assert.notEqual(ui, api);

const loginHeaders = { 'Content-Type': 'application/json', 'X-Q2A-Request': '1' };

test('both origins serve public HTTPS routes and redirect HTTP', async () => {
  for (const [origin, path] of [[ui, '/?qa=login'], [api, '/health']]) {
    const http = await fetch(origin.replace('https:', 'http:') + path, { redirect: 'manual' });
    assert.equal(http.status, 308);
    assert.equal(http.headers.get('location'), origin + path);
    const https = await fetch(origin + path);
    assert.equal(https.status, 200);
    assert.equal(https.headers.get('x-content-type-options'), 'nosniff');
    if (origin === api) assert.deepEqual(await https.json(), { status: 'ok' });
    else assert.match(await https.text(), /name="dologin"/);
  }
});

test('the public edge blocks private routes and anonymous API access', async () => {
  for (const path of ['/api/v1/internal/reads', '/api/v1/internal/cache']) {
    const response = await fetch(api + path, {
      method: 'POST', headers: loginHeaders, body: '{}',
    });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '', 'expected the edge to block the request');
  }
  assert.equal((await fetch(ui + '/.env.demo')).status, 404);
  for (const path of ['/api/v1/auth/me', '/api/v1/admin/ai/usage']) {
    assert.equal((await fetch(api + path)).status, 401);
  }
});

test('CORS allows exactly the configured frontend origin', async () => {
  const preflight = (origin) => fetch(api + '/api/v1/auth/login', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,x-q2a-request',
    },
  });
  const allowed = await preflight(ui);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), ui);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), 'true');
  const unrelated = await preflight('https://unrelated.example');
  assert.equal(unrelated.status, 403);
  assert.equal(unrelated.headers.get('access-control-allow-origin'), null);
});

const { DEMO_TEST_USER_EMAIL: email, DEMO_TEST_USER_PASSWORD: password } = process.env;
test('a regular user gets a secure session and is denied admin usage', {
  skip: email && password ? false : 'set DEMO_TEST_USER_EMAIL and DEMO_TEST_USER_PASSWORD',
}, async () => {
  const login = await fetch(api + '/api/v1/auth/login', {
    method: 'POST', headers: loginHeaders, body: JSON.stringify({ emailhandle: email, password }),
  });
  assert.equal(login.status, 200);
  const session = login.headers.getSetCookie().find(cookie => cookie.startsWith('q2a_node_session='));
  assert.ok(session, 'expected a session cookie');
  const cookie = session.split(';', 1)[0];
  try {
    assert.ok(/;\s*Secure(?:;|$)/i.test(session), 'expected Secure');
    assert.ok(/;\s*HttpOnly(?:;|$)/i.test(session), 'expected HttpOnly');
    assert.ok(/;\s*SameSite=Strict(?:;|$)/i.test(session), 'expected SameSite=Strict');
    assert.ok(!/;\s*Domain=/i.test(session), 'expected a host-only cookie');
    assert.equal((await fetch(api + '/api/v1/auth/me', { headers: { cookie } })).status, 200);
    assert.equal((await fetch(api + '/api/v1/admin/ai/usage', { headers: { cookie } })).status, 403);
  } finally {
    const response = await fetch(api + '/api/v1/auth/logout', {
      method: 'POST', headers: { ...loginHeaders, cookie }, body: '{}',
    });
    assert.equal(response.status, 204);
  }
});
