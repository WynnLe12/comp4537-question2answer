// src/q2a/mail.js (qa_send_email(), qa_send_notification()) and src/q2a/notify.js (the qa_event_notify module),
// with the SMTP transport replaced by a recorder: which emails go out, to whom, when, and with exactly what
// subject and body.
jest.mock('nodemailer', () => {
  const transports = [];
  return {
    transports,
    createTransport: config => {
      const transport = { config, sent: [], fail: null, sendMail: async message => { if (transport.fail) throw transport.fail; transport.sent.push(message); } };
      transports.push(transport);
      return transport;
    },
  };
});
const nodemailer = require('nodemailer');
const php = require('../fixtures/php-helpers-outputs.json');
const mail = require('../../src/q2a/mail');
const notify = require('../../src/q2a/notify');

const SITE = {
  smtp_active: '1', smtp_address: 'smtp.test', smtp_port: '2525', smtp_secure: '', smtp_authenticate: '', site_title: 'Site', site_url: 'http://site.test/',
  from_email: 'from@site.test', feedback_email: 'admin@site.test', neat_urls: '1', q_urls_title_length: '50', q_urls_remove_accents: '',
  block_bad_words: '', notify_admin_q_post: '', moderate_notify_admin: '', register_notify_admin: '', moderate_users: '',
  flagging_notify_first: '1', flagging_notify_every: '2',
};
const optionsWith = (values = {}) => ({ get: name => ({ ...SITE, ...values })[name] ?? '' });
// The transaction helper notify.js and mail.js are given: work queued until commit, and the user lookup.
function transaction(accounts = {}) {
  const tasks = [];
  const lookups = [];
  return {
    tasks, lookups,
    afterCommit: { push: task => tasks.push(task) },
    findUserEmailHandle: async userid => { lookups.push(userid); return accounts[userid] ?? null; },
    commit: () => Promise.all(tasks.map(task => task())),
  };
}
const allSent = () => nodemailer.transports.flatMap(t => t.sent);
beforeEach(() => { for (const t of nodemailer.transports) { t.sent.length = 0; t.fail = null; } });

test("strtr() replaces as PHP's strtr() does: longest key first, each place once", () => {
  const wrong = php.strtr.filter(([value, subs, expected]) => mail.strtr(value, subs) !== expected);
  expect(wrong).toEqual([]);
});

describe('qa_send_email()', () => {
  const message = { fromemail: 'from@site.test', fromname: 'Site', toemail: 'to@x.test', toname: 'Bob', subject: 'Hi', body: 'line1\r\nline2\rline3' };
  test('without SMTP nothing is sent', async () => {
    expect(await mail.sendEmail(optionsWith({ smtp_active: '' }), message)).toBe(false);
    expect(await mail.sendEmail(optionsWith({ smtp_active: '0' }), message)).toBe(false);
    expect(allSent()).toEqual([]);
  });
  test("sends with PHPMailer's line endings, sender and envelope", async () => {
    expect(await mail.sendEmail(optionsWith(), message)).toBe(true);
    expect(allSent()).toEqual([{
      from: { name: 'Site', address: 'from@site.test' }, sender: 'from@site.test', envelope: { from: 'from@site.test', to: 'to@x.test' },
      to: { name: 'Bob', address: 'to@x.test' }, subject: 'Hi', text: 'line1\nline2\nline3\n\n',
    }]);
  });
  test('a body already ending in a line break gets one more; HTML goes as html; a reply-to is added when given', async () => {
    await mail.sendEmail(optionsWith(), { ...message, toname: null, body: '<p>x</p>\n', html: true, replytoemail: 'r@x.test', replytoname: null });
    expect(allSent()[0]).toMatchObject({ to: { name: '', address: 'to@x.test' }, html: '<p>x</p>\n\n', replyTo: { name: '', address: 'r@x.test' } });
    expect(allSent()[0].text).toBeUndefined();
    await mail.sendEmail(optionsWith(), { ...message, replytoemail: 'r@x.test', replytoname: 'Ann' });
    expect(allSent()[1].replyTo).toEqual({ name: 'Ann', address: 'r@x.test' });
    await mail.sendEmail(optionsWith(), { ...message, body: 42 });
    expect(allSent()[2].text).toBe('42\n\n');
    expect(allSent()[2].replyTo).toBeUndefined();
  });
  test('a failed send is reported as not sent', async () => {
    const options = optionsWith({ smtp_address: 'failing.test' });
    await mail.sendEmail(options, message);
    nodemailer.transports.find(t => t.config.host === 'failing.test').fail = new Error('connection refused');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await mail.sendEmail(options, message)).toBe(false);
      expect(spy).toHaveBeenCalledWith('Question2Answer email send error:', 'connection refused');
    } finally { spy.mockRestore(); }
  });
  test.each([
    ['', { host: 'cfg1.test', port: 25, secure: false, requireTLS: false, tls: { rejectUnauthorized: false }, auth: undefined }],
    ['ssl', { host: 'cfg1.test', port: 25, secure: true, requireTLS: false, tls: undefined, auth: undefined }],
    ['tls', { host: 'cfg1.test', port: 25, secure: false, requireTLS: true, tls: undefined, auth: undefined }],
  ])('smtp_secure %j sets up the transport as PHPMailer connects', async (secure, config) => {
    await mail.sendEmail(optionsWith({ smtp_address: 'cfg1.test', smtp_port: '25', smtp_secure: secure }), message);
    expect(nodemailer.transports.filter(t => t.config.host === 'cfg1.test' && t.config.secure === config.secure && t.config.requireTLS === config.requireTLS).map(t => t.config)).toEqual([config]);
  });
  test('authentication uses the stored username and password, and one transport serves each configuration', async () => {
    const options = optionsWith({ smtp_address: 'auth.test', smtp_authenticate: '1', smtp_username: 'u', smtp_password: 'p' });
    await mail.sendEmail(options, message);
    await mail.sendEmail(options, message);
    const made = nodemailer.transports.filter(t => t.config.host === 'auth.test');
    expect(made).toHaveLength(1);
    expect(made[0].config.auth).toEqual({ user: 'u', pass: 'p' });
    expect(made[0].sent).toHaveLength(2);
  });
});

describe('qa_send_notification()', () => {
  const args = { subject: '^site_title: ^x', body: 'To ^handle at ^email^open^url^close^site_url', subs: { '^x': 'X', '^url': 'U' } };
  test('builds the greeting, the standard substitutions and the sender', async () => {
    const email = await mail.prepareNotification(transaction(), optionsWith(), { ...args, userid: null, email: 'a@x.test', handle: 'ann' });
    expect(email).toEqual({
      fromemail: 'from@site.test', fromname: 'Site', toemail: 'a@x.test', toname: 'ann', html: false,
      subject: 'Site: X', body: 'ann,\n\nTo ann at a@x.test\nU\nhttp://site.test/',
    });
  });
  test('without a handle there is no greeting', async () => {
    const email = await mail.prepareNotification(transaction(), optionsWith(), { ...args, email: 'a@x.test' });
    expect(email.body).toBe('To  at a@x.test\nU\nhttp://site.test/');
    expect(email.toname).toBeNull();
  });
  test('looks up the email and handle of a user when they are missing or the email is "@"', async () => {
    const q = transaction({ 7: { email: 'seven@x.test', handle: 'seven' } });
    const email = await mail.prepareNotification(q, optionsWith(), { ...args, userid: 7, email: '@' });
    expect(q.lookups).toEqual([7]);
    expect(email).toMatchObject({ toemail: 'seven@x.test', toname: 'seven' });
    // a given valid email and handle are kept; a missing handle alone is looked up
    const q2 = transaction({ 7: { email: 'seven@x.test', handle: 'seven' } });
    expect(await mail.prepareNotification(q2, optionsWith(), { ...args, userid: 7, email: 'own@x.test', handle: 'given' })).toMatchObject({ toemail: 'own@x.test', toname: 'given' });
    expect(q2.lookups).toEqual([]);
    expect(await mail.prepareNotification(q2, optionsWith(), { ...args, userid: 7, email: 'own@x.test' })).toMatchObject({ toemail: 'own@x.test', toname: 'seven' });
    expect(q2.lookups).toEqual([7]);
  });
  test('nothing is built without a valid address', async () => {
    const q = transaction({ 7: { email: 'not-an-email', handle: 'x' } });
    expect(await mail.prepareNotification(q, optionsWith(), { ...args, userid: 7, email: '@' })).toBeNull();
    expect(await mail.prepareNotification(q, optionsWith(), { ...args, userid: 8, email: null })).toBeNull();
    expect(await mail.prepareNotification(q, optionsWith(), { ...args, email: 'bad' })).toBeNull();
    expect(await mail.prepareNotification(q, optionsWith(), { ...args })).toBeNull();
  });
  test('sendNotification() sends at once; queueNotification() and queueEmail() wait for the commit', async () => {
    expect(await mail.sendNotification(transaction(), optionsWith(), { ...args, email: 'now@x.test' })).toBe(true);
    expect(await mail.sendNotification(transaction(), optionsWith(), { ...args, email: 'bad' })).toBe(false);
    expect(allSent().map(m => m.to.address)).toEqual(['now@x.test']);
    const q = transaction();
    await mail.queueNotification(q, optionsWith(), { ...args, email: 'later@x.test' });
    await mail.queueNotification(q, optionsWith(), { ...args, email: 'bad' });
    mail.queueEmail(q, optionsWith(), { fromemail: 'f@x.test', fromname: 'F', toemail: 'direct@x.test', toname: 'D', subject: 's', body: 'b' });
    expect(allSent()).toHaveLength(1);
    expect(q.tasks).toHaveLength(2);
    await q.commit();
    expect(allSent().map(m => m.to.address)).toEqual(['now@x.test', 'later@x.test', 'direct@x.test']);
  });
});

describe('notification events', () => {
  const sent = async (event, options, params, accounts) => {
    const before = allSent().length;
    const q = transaction(accounts);
    await notify[event](q, optionsWith(options), params);
    await q.commit();
    return allSent().slice(before).map(m => ({ to: m.to.address, subject: m.subject, text: m.text }));
  };
  const question = { postid: 1, userid: 7, cookieid: null, notify: 'asker@x.test', handle: 'asker', title: 'Why bad sky?' };

  describe('a_post: the question author', () => {
    test('is emailed with the answer', async () => {
      expect(await sent('answerPosted', {}, { userid: 8, handle: 'helper', postid: 2, text: 'Because.', question })).toEqual([{
        to: 'asker@x.test', subject: 'Your Site question was answered',
        text: expect.stringMatching(/^asker,\n\nYour question on Site has been answered by helper:\n\n\nBecause\.\n\n\nYour question was:\n\n\nWhy bad sky\?\n\n/),
      }]);
    });
    test('the link points at the answer on the question page', async () => {
      const [email] = await sent('answerPosted', {}, { userid: 8, handle: 'h', postid: 2, text: 't', question });
      expect(email.text).toContain('http://site.test/1/why-bad-sky?show=2#a2');
    });
    test('blocked words in the answer are censored; an anonymous author shows their name or "anonymous"', async () => {
      const [named] = await sent('answerPosted', { block_bad_words: 'bad' }, { userid: null, handle: null, name: 'Guest', postid: 2, text: 'bad answer', question });
      expect(named.text).toContain('answered by Guest:');
      expect(named.text).toContain('*** answer');
      const [nameless] = await sent('answerPosted', {}, { userid: null, handle: null, name: '', postid: 3, text: 't', question });
      expect(nameless.text).toContain('answered by anonymous:');
    });
    test('is not emailed for their own answer or without notifications', async () => {
      expect(await sent('answerPosted', {}, { userid: 7, handle: 'asker', postid: 2, text: 't', question })).toEqual([]);
      expect(await sent('answerPosted', {}, { userid: 8, handle: 'h', postid: 2, text: 't', question: { ...question, notify: null } })).toEqual([]);
      expect(await sent('answerPosted', {}, { userid: 8, handle: 'h', postid: 2, text: 't', question: { ...question, notify: undefined } })).toEqual([]);
    });
    test('an anonymous asker is recognised by their visitor cookie', async () => {
      const anon = { ...question, userid: null, cookieid: '99', notify: 'anon@x.test', handle: null };
      expect(await sent('answerPosted', {}, { userid: null, cookieid: '99', handle: null, postid: 2, text: 't', question: anon })).toEqual([]);
      expect(await sent('answerPosted', {}, { userid: null, cookieid: '98', handle: null, postid: 2, text: 't', question: anon })).toHaveLength(1);
    });
  });

  describe('q_post', () => {
    const followanswer = { postid: 5, userid: 9, cookieid: null, notify: 'answerer@x.test', handle: 'answerer', content: '<b>bad</b> answer', format: 'html' };
    test('the author of a followed answer is told, with the answer text censored', async () => {
      const emails = await sent('questionPosted', { block_bad_words: 'bad' }, { userid: 8, handle: 'asker2', postid: 12, title: 'New bad question', text: 'body', followanswer });
      expect(emails).toEqual([{ to: 'answerer@x.test', subject: 'Your Site answer has a related question', text: expect.any(String) }]);
      expect(emails[0].text).toContain('asker2');
      expect(emails[0].text).toContain('*** answer');
      expect(emails[0].text).toContain('New *** question');
      expect(emails[0].text).toContain('http://site.test/12/new-question');
    });
    test('not when they asked it themselves, have notifications off, or there is no followed answer', async () => {
      expect(await sent('questionPosted', {}, { userid: 9, handle: 'answerer', postid: 12, title: 'T', text: 'b', followanswer })).toEqual([]);
      expect(await sent('questionPosted', {}, { userid: 8, handle: 'a', postid: 12, title: 'T', text: 'b', followanswer: { ...followanswer, notify: null } })).toEqual([]);
      expect(await sent('questionPosted', {}, { userid: 8, handle: 'a', postid: 12, title: 'T', text: 'b' })).toEqual([]);
    });
    test('the admin is told of every new question when notify_admin_q_post is on', async () => {
      const emails = await sent('questionPosted', { notify_admin_q_post: '1' }, { userid: null, handle: null, name: null, postid: 12, title: 'Title', text: 'Body text' });
      expect(emails).toEqual([{ to: 'admin@site.test', subject: 'Site has a new question', text: expect.stringContaining('Body text') }]);
      expect(emails[0].text).toContain('anonymous');
      expect(emails[0].text).not.toMatch(/^.*,\n\n/); // no greeting: the admin has no handle
    });
  });

  describe('c_post: the parent author, then earlier commenters once each', () => {
    const parent = { postid: 2, basetype: 'A', userid: 7, cookieid: null, notify: '@', handle: 'parent', content: 'The <i>answer</i>', format: 'html' };
    const q = { postid: 1, title: 'Q title' };
    const accounts = { 7: { email: 'seven@x.test', handle: 'parent' }, 9: { email: 'nine@x.test', handle: 'nine' }, 10: { email: 'ten@x.test', handle: 'ten' } };
    test('the answer author and each earlier commenter, each address once, never the commenter themselves', async () => {
      const thread = [
        { userid: 7, notify: '@', handle: 'parent' }, // the parent author again: already told
        { userid: 9, notify: '@', handle: 'nine' },
        { userid: 9, notify: '@', handle: 'nine' }, // the same user again
        { userid: null, notify: 'x@x.test' },
        { userid: null, notify: 'x@x.test' }, // the same address again
        { userid: 8, notify: '@', handle: 'me' }, // the new comment's author
        { userid: 10, notify: null }, // notifications off
        { userid: null, cookieid: '55', notify: 'anon@x.test' },
      ];
      const emails = await sent('commentPosted', {}, { userid: 8, handle: 'me', postid: 6, text: 'my comment', parent, question: q, thread }, accounts);
      expect(emails.map(e => [e.to, e.subject])).toEqual([
        ['seven@x.test', 'Your Site answer has a new comment'],
        ['nine@x.test', 'Your Site comment has been added to'],
        ['x@x.test', 'Your Site comment has been added to'],
        ['anon@x.test', 'Your Site comment has been added to'],
      ]);
      expect(emails[0].text).toContain('The answer'); // the answer's text, as plain text
      expect(emails[0].text).toContain('my comment');
      expect(emails[0].text).toContain('http://site.test/1/q-title?show=6#c6');
    });
    test('a comment on a question names the question', async () => {
      const qparent = { postid: 1, basetype: 'Q', userid: 7, notify: 'q@x.test', handle: 'asker', title: 'Bad question title' };
      const emails = await sent('commentPosted', { block_bad_words: 'bad' }, { userid: 8, handle: 'me', postid: 6, text: 'c', parent: qparent, question: q, thread: [] });
      expect(emails).toEqual([{ to: 'q@x.test', subject: 'Your Site question has a new comment', text: expect.stringContaining('*** question title') }]);
    });
    test('a commenter given by user ID is not emailed again after being told by email address', async () => {
      const thread = [{ userid: 9, notify: 'nine@x.test' }, { userid: 9, notify: '@' }, { userid: 9, notify: 'nine@x.test' }];
      const emails = await sent('commentPosted', {}, { userid: 8, handle: 'me', postid: 6, text: 'c', parent: { ...parent, notify: null }, question: q, thread }, accounts);
      expect(emails.map(e => e.to)).toEqual(['nine@x.test', 'nine@x.test']);
    });
    test('a parent author told by user ID is not emailed again as a commenter', async () => {
      const thread = [{ userid: 7, notify: '@' }];
      expect((await sent('commentPosted', {}, { userid: 8, postid: 6, text: 'c', parent, question: q, thread }, accounts)).map(e => e.to)).toEqual(['seven@x.test']);
    });
    test('the parent author is not told of their own comment', async () => {
      expect(await sent('commentPosted', {}, { userid: 7, handle: 'parent', postid: 6, text: 'c', parent, question: q, thread: [] }, accounts)).toEqual([]);
    });
  });

  describe('moderation queue', () => {
    test('nothing unless moderate_notify_admin', async () => {
      expect(await sent('queued', {}, { basetype: 'Q', requeue: false, postid: 3, title: 'T', text: 'b' })).toEqual([]);
    });
    test('a queued question: its title and text, and links to it and to the queue', async () => {
      const [email] = await sent('queued', { moderate_notify_admin: '1' }, { basetype: 'Q', requeue: false, handle: 'u', postid: 3, title: 'Title', text: 'Text' });
      expect(email).toMatchObject({ to: 'admin@site.test', subject: 'Site moderation' });
      expect(email.text).toContain('Title\n\nText');
      expect(email.text).toContain('http://site.test/3/title');
      expect(email.text).toContain('http://site.test/admin/moderate');
    });
    test('a requeued answer: its text and a link to it on the question page', async () => {
      const [email] = await sent('queued', { moderate_notify_admin: '1' }, { basetype: 'A', requeue: true, handle: null, name: 'Guest', postid: 4, text: 'Answer text', question: { postid: 3, title: 'Title' } });
      expect(email.text).toContain('Guest');
      expect(email.text).toContain('Answer text');
      expect(email.text).toContain('http://site.test/3/title?show=4#a4');
      expect(mail.lang.remoderate_body).not.toBe(mail.lang.moderate_body);
      expect(email.text).toContain(mail.lang.remoderate_body.split('^')[0]);
    });
    test('a question with no title still reads cleanly', async () => {
      const [email] = await sent('queued', { moderate_notify_admin: '1' }, { basetype: 'Q', requeue: false, postid: 3, text: 'Only text' });
      expect(email.text).toContain('\nOnly text\n');
    });
  });

  describe('flags', () => {
    const oldpost = { postid: 4, basetype: 'A', handle: null, name: null, title: null, content: 'Flagged <b>answer</b>', format: 'html' };
    const flag = (flagcount, options) => sent('flagged', options, { flagcount, oldpost, question: { postid: 3, title: 'Title' } });
    test.each([
      [{ flagging_notify_first: '1', flagging_notify_every: '2' }, [1, 3, 5]],
      [{ flagging_notify_first: '2', flagging_notify_every: '3' }, [2, 5]],
      [{ flagging_notify_first: '1', flagging_notify_every: '0' }, [1]],
      [{ flagging_notify_first: '0', flagging_notify_every: '0' }, []],
    ])('with %j the admin hears at flags %j', async (options, expected) => {
      const counts = [];
      for (const count of [1, 2, 3, 4, 5, 6]) if ((await flag(count, options)).length) counts.push(count);
      expect(counts).toEqual(expected);
    });
    test('the email names the post, the count and the flagged-posts page', async () => {
      const [one] = await flag(1);
      expect(one).toMatchObject({ to: 'admin@site.test', subject: 'Site has a flagged post' });
      expect(one.text).toContain('1 flag');
      expect(one.text).toContain('Flagged answer');
      expect(one.text).toContain('anonymous');
      expect(one.text).toContain('http://site.test/3/title?show=4#a4');
      expect(one.text).toContain('http://site.test/admin/flagged');
      const [three] = await flag(3);
      expect(three.text).toContain('3 flags');
    });
  });

  describe('a_select: the answer author', () => {
    const answer = { postid: 4, userid: 9, cookieid: null, notify: 'answerer@x.test', handle: 'answerer', content: 'bad answer', format: '' };
    test('is told, with the question title and answer censored', async () => {
      const [email] = await sent('answerSelected', { block_bad_words: 'bad' }, { userid: 7, handle: 'asker', answer, question: { postid: 3, title: 'Bad title' } });
      expect(email).toMatchObject({ to: 'answerer@x.test', subject: 'Your Site answer has been selected!' });
      expect(email.text).toContain('asker');
      expect(email.text).toContain('*** title');
      expect(email.text).toContain('*** answer');
      expect(email.text).toContain('http://site.test/3/title?show=4#a4');
    });
    test('an anonymous selector shows as anonymous; no email for their own answer or with notifications off', async () => {
      const [email] = await sent('answerSelected', {}, { userid: null, handle: null, answer, question: { postid: 3, title: 'T' } });
      expect(email.text).toContain('anonymous');
      expect(await sent('answerSelected', {}, { userid: 9, handle: 'answerer', answer, question: { postid: 3, title: 'T' } })).toEqual([]);
      expect(await sent('answerSelected', {}, { userid: 7, handle: 'a', answer: { ...answer, notify: null }, question: { postid: 3, title: 'T' } })).toEqual([]);
    });
  });

  describe('users', () => {
    test('a new user is announced to the admin only if register_notify_admin, with the approval link when users are moderated', async () => {
      expect(await sent('userRegistered', {}, { handle: 'newbie' })).toEqual([]);
      const [plain] = await sent('userRegistered', { register_notify_admin: '1' }, { handle: 'new bie' });
      expect(plain).toEqual({ to: 'admin@site.test', subject: 'Site has a new registered user', text: expect.stringContaining('http://site.test/user/new%20bie') });
      expect(plain.text).not.toContain('admin/approve');
      const [moderated] = await sent('userRegistered', { register_notify_admin: '1', moderate_users: '1' }, { handle: 'newbie' });
      expect(moderated.text).toContain('Click below to approve the user');
      expect(moderated.text).toContain('http://site.test/admin/approve');
    });
    test.each([[10, 0, true], [100, 9, true], [10, 10, false], [9, 0, false], [0, 10, false], [120, 100, false]])(
      'level %i from %i: approval email %s', async (level, oldlevel, expected) => {
        const emails = await sent('userLevelChanged', {}, { userid: 7, handle: 'bob', level, oldlevel }, { 7: { email: 'bob@x.test', handle: 'bob' } });
        expect(emails.length).toBe(expected ? 1 : 0);
        if (expected) expect(emails[0]).toEqual({ to: 'bob@x.test', subject: 'Your Site user has been approved', text: expect.stringContaining('http://site.test/user/bob') });
      });
    test("a wall post tells the wall's owner, never someone posting on their own wall", async () => {
      const accounts = { 7: { email: 'owner@x.test', handle: 'owner' } };
      const [email] = await sent('wallPosted', { block_bad_words: 'bad' }, { userid: 8, handle: 'friend', touserid: 7, tohandle: 'owner', text: 'bad news' }, accounts);
      expect(email).toMatchObject({ to: 'owner@x.test', subject: 'Post on your Site wall' });
      expect(email.text).toContain('friend');
      expect(email.text).toContain('*** news');
      expect(email.text).toContain('http://site.test/user/owner#wall');
      expect(await sent('wallPosted', {}, { userid: 7, handle: 'owner', touserid: '7', tohandle: 'owner', text: 'x' }, accounts)).toEqual([]);
      const [anon] = await sent('wallPosted', {}, { userid: null, handle: null, touserid: 7, tohandle: 'owner', text: 'x' }, accounts);
      expect(anon.text).toContain('anonymous');
    });
  });
});
