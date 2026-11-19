const request = require('supertest');
const { createApp } = require('../../src/app');
const { path } = require('../../src/q2a/paths');
const { strtr } = require('../../src/q2a/mail');
const text = require('../../src/q2a/text');
const phpPaths = require('../fixtures/php-path-outputs.json');

describe('ported Q2A helpers used by account emails', () => {
  test.each(phpPaths)('qa_path() format %i for %j matches PHP', (format, req, params, expected) => {
    expect(path(req, params, 'http://localhost:8080/', format)).toBe(expected);
  });
  test('strtr() replaces the longest key first, once', () => {
    expect(strtr('^site_title - ^site_titles ^code', { '^site_title': 'S', '^code': '^site_title' })).toBe('S - Ss ^site_title');
  });
  test('block_bad_usernames words match whole words, with * as a wildcard', () => {
    expect(text.blockWordsMatch('Anonymous', 'anonymous')).toBe(true);
    expect(text.blockWordsMatch('the-anonymous-one', 'anonymous')).toBe(true);
    expect(text.blockWordsMatch('anonymously', 'anonymous')).toBe(false);
    expect(text.blockWordsMatch('badword7', 'bad*')).toBe(true);
    expect(text.blockWordsMatch('anyone', '')).toBe(false);
  });
  test('email codes are eight base-36 characters', () => {
    expect(text.randomAlphanum(8)).toMatch(/^[0-9a-z]{8}$/);
  });
});

describe('account routes (service replaced in these tests)', () => {
  const calls = [];
  const accountService = new Proxy({}, {
    get: (target, name) => async req => { calls.push([name, req]); return name === 'finishPasswordReset' ? { token: 'a.b.c', ttl: 60, user: { id: 1 } } : { ok: true }; },
  });
  const app = createApp({ service: {}, accountService });
  test('route each operation', async () => {
    calls.length = 0;
    const send = (method, url, body = {}) => request(app)[method](url).set('X-Q2A-Request', '1').send(body).expect(200);
    await send('patch', '/api/v1/account', { email: 'a@b.test' });
    await send('put', '/api/v1/account/password', { oldPassword: 'x', newPassword: 'y' });
    await send('post', '/api/v1/account/confirmation-email');
    await send('post', '/api/v1/account/confirm-email', { handle: 'h', code: 'c' });
    await send('post', '/api/v1/account/password-reset', { emailHandle: 'h' });
    await send('post', '/api/v1/account/unsubscribe');
    expect(calls.map(([name]) => name)).toEqual(['saveProfile', 'changePassword', 'sendConfirmation', 'confirmEmail', 'startPasswordReset', 'unsubscribe']);
  });
  test('a completed reset sets the session cookie', async () => {
    const response = await request(app).post('/api/v1/account/password-reset/complete').set('X-Q2A-Request', '1').send({}).expect(200);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    expect(response.body).toEqual({ user: { id: 1 } });
  });
  test('the avatar upload takes the image as the body, with the API request header', async () => {
    calls.length = 0;
    await request(app).put('/api/v1/account/avatar').set('Content-Type', 'image/png').send(Buffer.from('png')).expect(403);
    await request(app).put('/api/v1/account/avatar').set('X-Q2A-Request', '1').set('Content-Type', 'application/json').send({}).expect(403);
    await request(app).put('/api/v1/account/avatar').set('X-Q2A-Request', '1').set('Content-Type', 'image/png').send(Buffer.from('png')).expect(200);
    expect(calls[0][1].image).toEqual(Buffer.from('png'));
    await request(app).put('/api/v1/account/avatar').set('X-Q2A-Request', '1').set('Content-Type', 'image/png').send(Buffer.alloc(2 * 1024 * 1024 + 1)).expect(413);
  });
});

describe('parity test helper: rate-limit changes across an hour boundary', () => {
  const { limitDelta } = require('../parity/post-helpers');
  test('counts within the same hour are subtracted', () => {
    expect(limitDelta({ u: { period: 7, count: 3 } }, { u: { period: 7, count: 4 } })).toBe(1);
  });
  test('a new hour restarts the count, so the change is the new count', () => {
    expect(limitDelta({ u: { period: 7, count: 3 } }, { u: { period: 8, count: 1 } })).toBe(1);
    expect(limitDelta({}, { u: { period: 8, count: 1 } })).toBe(1);
    expect(limitDelta({ u: { period: 7, count: 3 } }, { u: { period: 7, count: 3 } })).toBe(0);
  });
});
