const request = require('supertest');
const { createApp } = require('../../src/app');
const text = require('../../src/q2a/text');
const { qPathAbsolute } = require('../../src/q2a/paths');
const notify = require('../../src/q2a/notify');
const phpSlugs = require('../fixtures/php-slug-outputs.json');

const options = values => ({ get: name => ({ site_url: 'http://localhost:8080/', neat_urls: '5', q_urls_title_length: '50', q_urls_remove_accents: '', feedback_email: 'admin@example.test', site_title: 'Site', from_email: 'no-reply@example.test', ...values }[name] ?? '') });

describe('ported helpers used in notification emails match PHP', () => {
  test.each(phpSlugs)('%j (%s, %s)', (title, mode, setting, expected) => {
    expect(mode === 'block' ? text.blockWordsReplace(title, setting) : text.slugify(title, mode, setting)).toBe(expected);
  });
  test('qa_q_path() links to an answer on its question page', () => {
    expect(qPathAbsolute(options(), 12, 'Why is the sky blue?', 'A', 34)).toBe('http://localhost:8080/index.php?qa=12&qa_1=why-is-the-sky-blue&show=34#a34');
  });
});

describe('notification rules (emails captured instead of sent)', () => {
  const queued = [];
  const q = { afterCommit: { push: task => queued.push(task) }, findUserEmailHandle: async userid => ({ email: `u${userid}@example.test`, handle: `user${userid}` }) };
  beforeEach(() => { queued.length = 0; });
  test('answers notify the question author unless they wrote the answer', async () => {
    const question = { postid: 1, userid: 7, notify: '@', title: 'Q' };
    await notify.answerPosted(q, options(), { userid: 8, handle: 'b', postid: 2, text: 'hi', question });
    await notify.answerPosted(q, options(), { userid: 7, handle: 'a', postid: 3, text: 'mine', question });
    expect(queued).toHaveLength(1);
  });
  test('comment threads email each address once', async () => {
    const parent = { postid: 2, basetype: 'A', userid: 7, notify: '@', content: 'answer', format: '' };
    const thread = [{ userid: 7, notify: '@' }, { userid: 9, notify: '@' }, { userid: null, notify: 'x@example.test' }, { userid: null, notify: 'x@example.test' }];
    await notify.commentPosted(q, options(), { userid: 8, handle: 'b', postid: 5, text: 'c', parent, question: { postid: 1, title: 'Q' }, thread });
    expect(queued).toHaveLength(3);
  });
  test('flags notify the admin on the first and then every second flag', async () => {
    const oldpost = { postid: 1, basetype: 'Q', title: 'Q', content: '', format: '', name: null };
    for (const flagcount of [1, 2, 3, 4, 5]) await notify.flagged(q, options({ flagging_notify_first: '1', flagging_notify_every: '2' }), { flagcount, oldpost, question: { postid: 1, title: 'Q' } });
    expect(queued).toHaveLength(3);
  });
});

describe('feedback route (service replaced)', () => {
  const calls = [];
  const app = createApp({ service: {}, feedbackService: { sendFeedback: async req => { calls.push(req); return { sent: true }; } } });
  test('passes the message and the browser through', async () => {
    await request(app).post('/api/v1/feedback').set('X-Q2A-Request', '1').set('User-Agent', 'TestBrowser/1').send({ message: 'Hi' }).expect(200);
    expect(calls[0]).toMatchObject({ body: { message: 'Hi' }, browser: 'TestBrowser/1' });
  });
});
