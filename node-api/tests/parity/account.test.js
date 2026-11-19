// Account parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API each
// save profiles, change passwords, upload avatars, confirm email addresses, reset forgotten
// passwords and unsubscribe, through the real account, confirm, forgot, reset and unsubscribe pages.
// Outcomes, page messages, everything written to the user's account and profile, upload limits,
// avatar blobs, and the emails sent (caught by Mailpit) must match.
const { randomBytes } = require('node:crypto');
const sharp = require('sharp');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, latestEmail, limitRows, limitDelta } = require('./post-helpers');

describe('PHP ↔ Node account parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    for (const pool of [phpPool, nodePool]) await pool.query("DELETE FROM qa_iplimits WHERE action='U'");
    backends = [];
    for (const [tag, pool, make] of [
      ['p', phpPool, () => siteDriver('php', PHP_URL, phpPool)],
      ['u', nodePool, () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', nodePool, () => apiDriver(nodePool)],
    ]) {
      const drivers = { actor: make(), other: make() };
      const handles = Object.fromEntries(Object.keys(drivers).map(label => [label, `c${label}${tag}${suffix}`]));
      for (const label of Object.keys(drivers)) await drivers[label].register(handles[label]);
      const users = {};
      for (const [label, handle] of Object.entries(handles)) {
        const [[row]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [handle]);
        users[label] = row.userid;
      }
      backends.push({ ...drivers, pool, handles, users, tag, make, mark: `${tag}${suffix}` });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  // Everything about the test users that the account pages write, with each backend's handles masked.
  async function accountState(b) {
    const mask = value => (typeof value === 'string' ? value.split(b.mark).join('<b>') : value);
    const state = {};
    for (const [label, userid] of Object.entries(b.users)) {
      // PHP's sessioncode belongs to PHP logins; Node keeps its own sessions (see the auth notes).
      const [[user]] = await b.pool.execute(
        'SELECT handle, email, flags, emailcode, passhash IS NOT NULL AS haspasshash, passsalt IS NULL AND passcheck IS NULL AS nolegacy, ' +
        'avatarblobid IS NOT NULL AS hasavatar, avatarwidth, avatarheight, written IS NOT NULL AS written FROM qa_users WHERE userid=?', [userid]);
      const [profile] = await b.pool.execute('SELECT title, content FROM qa_userprofile WHERE userid=? ORDER BY title', [userid]);
      const [[blobs]] = await b.pool.execute("SELECT COUNT(*) AS n, SUM(format='jpeg') AS jpeg FROM qa_blobs WHERE userid=?", [userid]);
      state[label] = {
        ...user, handle: mask(user.handle), email: mask(user.email), emailcode: user.emailcode ? 'set' : '',
        profile: profile.map(row => `${row.title}=${mask(row.content)}`), blobs: Number(blobs.n), jpegBlobs: Number(blobs.jpeg ?? 0),
      };
    }
    return state;
  }
  // The password hash changes on every save, so its change is compared rather than its value.
  const passhashes = async b => Object.fromEntries(await Promise.all(Object.entries(b.users).map(async ([label, userid]) => {
    const [[row]] = await b.pool.execute('SELECT passhash FROM qa_users WHERE userid=?', [userid]);
    return [label, row.passhash];
  })));
  const uploadRows = b => limitRows(b.pool, "SELECT userid AS k, period, count FROM qa_userlimits WHERE userid=? AND action='U'", [b.users.actor]);

  async function runEverywhere(perform, { emailTo } = {}) {
    const results = [];
    for (const b of backends) {
      const before = await passhashes(b);
      const uploadsBefore = await uploadRows(b);
      const started = Date.now() - 1000;
      const outcome = await perform(b);
      if (typeof outcome.message === 'string') outcome.message = outcome.message.split(b.mark).join('<b>');
      const after = await passhashes(b);
      const state = await accountState(b);
      for (const label of Object.keys(state)) state[label].passwordChanged = before[label] !== after[label];
      state.actor.uploads = limitDelta(uploadsBefore, await uploadRows(b));
      let email = null;
      if (emailTo) {
        const found = await latestEmail(emailTo(b), { after: started });
        const code = found && /(?:code: |Code: )([0-9a-z]{8})/.exec(found.text)?.[1];
        email = found && {
          subject: found.subject, from: found.from, to: found.to.map(t => ({ ...t, Name: t.Name.split(b.mark).join('<b>'), Address: t.Address.split(b.mark).join('<b>') })),
          text: (code ? found.text.split(code).join('<code>') : found.text).split(b.mark).join('<b>'),
          code,
        };
      }
      results.push({ outcome, state, email });
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.outcome.message).toBe(php.outcome.message);
    expect(ui.state).toEqual(php.state);
    expect(api.state).toEqual(php.state);
    if (php.outcome.accepted) expect(ui.outcome.backend).toBe('node-api-v1');
    if (emailTo) {
      const comparable = email => email && { ...email, code: undefined };
      expect(comparable(ui.email)).toEqual(comparable(php.email));
      expect(comparable(api.email)).toEqual(comparable(php.email));
    }
    return { php, ui, api, codes: results.map(r => r.email?.code) };
  }
  const withOptions = async (values, work) => {
    const previous = [];
    for (const pool of [phpPool, nodePool]) {
      const old = {};
      for (const [title, content] of Object.entries(values)) {
        const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [title]);
        old[title] = row?.content;
        await pool.execute('INSERT INTO qa_options (title,content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [title, content]);
      }
      previous.push([pool, old]);
    }
    try { return await work(); } finally {
      for (const [pool, old] of previous) {
        for (const [title, content] of Object.entries(old)) {
          if (content === undefined) await pool.execute('DELETE FROM qa_options WHERE title=?', [title]);
          else await pool.execute('UPDATE qa_options SET content=? WHERE title=?', [content, title]);
        }
      }
    }
  };
  const handle = (b, label = 'actor') => b.handles[label];
  const visitor = b => b.make();

  describe('profile', () => {
    test('a user saves their profile', async () => {
      const { php } = await runEverywhere(b => b.actor.saveProfile({
        handle: `cnew${b.mark}`, messages: false, wallPosts: false,
        profile: { name: 'Pat Example', location: 'Vancouver', website: 'https://example.test', about: `About ${b.mark}.` },
      }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.actor).toMatchObject({ handle: 'cnew<b>', flags: 16 | 256, written: 1 });
      expect(php.state.actor.profile).toContain('location=Vancouver');
      for (const b of backends) b.handles.actor = `cnew${b.mark}`;
    });
    test('a handle that is taken is refused; the other fields are still saved', async () => {
      const { php, api } = await runEverywhere(b => b.actor.saveProfile({ handle: handle(b, 'other'), messages: true, profile: { location: 'Victoria' } }));
      expect(php.outcome.accepted).toBe(false);
      expect(php.outcome.message).toBe('Username is taken - please try another');
      expect(api.outcome.errors).toEqual({ handle: 'exists' });
      expect(php.state.actor.profile).toContain('location=Victoria');
    });
    test('an invalid email address is refused', async () => {
      const { api } = await runEverywhere(b => b.actor.saveProfile({ email: 'not-an-email' }));
      expect(api.outcome.errors).toEqual({ email: 'invalid' });
    });
    test('changing the email address sends a confirmation link when confirmations are on', async () => {
      await withOptions({ confirm_user_emails: '1' }, async () => {
        const { php, codes } = await runEverywhere(b => b.actor.saveProfile({ email: `changed${b.mark}@example.test` }), { emailTo: b => `changed${b.mark}@example.test` });
        expect(php.state.actor).toMatchObject({ email: 'changed<b>@example.test', emailcode: 'set' });
        expect(php.state.actor.flags & 1).toBe(0);
        expect(php.email.subject).toBe('Question2Answer Q&A - Email Address Confirmation');
        for (const [i, b] of backends.entries()) b.code = codes[i];
      });
    });
    test('the link in that email confirms the address', async () => {
      const { php } = await runEverywhere(b => b.actor.confirmEmail(handle(b), b.code));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.actor).toMatchObject({ emailcode: '' });
      expect(php.state.actor.flags & 1).toBe(1);
    });
    test('a wrong confirmation code does nothing', async () => {
      const { php, api } = await runEverywhere(b => visitor(b).confirmEmail(handle(b, 'other'), 'zzzzzzzz'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'invalid_code' });
    });
    test('a signed-in user asks for a new confirmation link', async () => {
      const { php } = await runEverywhere(b => b.other.sendConfirmation(), { emailTo: b => `${handle(b, 'other')}@example.test` });
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.other.emailcode).toBe('set');
      expect(php.email.text).toContain('Confirmation code: <code>');
    });
  });

  describe('passwords', () => {
    test('a wrong current password is refused', async () => {
      const { php, api } = await runEverywhere(b => b.actor.changePassword('WrongPassword1', 'NewPassword456!'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { oldPassword: 'wrong' } });
    });
    test('a new password that is too short is refused', async () => {
      const { api } = await runEverywhere(b => b.actor.changePassword('Password123!', 'short'));
      expect(api.outcome).toMatchObject({ status: 400, fields: { newPassword: 'too_short' } });
    });
    test('a user changes their password', async () => {
      const { php } = await runEverywhere(b => b.actor.changePassword('Password123!', 'NewPassword456!'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.actor).toMatchObject({ passwordChanged: true, haspasshash: 1, nolegacy: 1 });
      // The session that changed it stays signed in.
      for (const b of backends) expect(await b.actor.signedIn()).toBe(true);
    });
    test('a visitor asks for a password reset code', async () => {
      const { php, codes } = await runEverywhere(b => visitor(b).forgotPassword(handle(b, 'other')), { emailTo: b => `${handle(b, 'other')}@example.test` });
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.other.emailcode).toBe('set');
      expect(php.email.subject).toBe('Question2Answer Q&A - Reset Forgotten Password');
      for (const [i, b] of backends.entries()) b.resetCode = codes[i];
    });
    test('an unknown user cannot ask for one', async () => {
      const { api } = await runEverywhere(b => visitor(b).forgotPassword(`nobody${b.mark}`));
      expect(api.outcome).toMatchObject({ status: 404, code: 'user_not_found' });
    });
    test('a wrong reset code is refused', async () => {
      const { php, api } = await runEverywhere(b => visitor(b).resetPassword(handle(b, 'other'), 'zzzzzzzz', 'ResetPassword789!'));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'invalid_code' });
    });
    test('the code from the email sets a new password and signs the visitor in', async () => {
      const browsers = backends.map(b => visitor(b));
      const { php } = await runEverywhere(b => browsers[backends.indexOf(b)].resetPassword(handle(b, 'other'), b.resetCode, 'ResetPassword789!'));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.other).toMatchObject({ passwordChanged: true, emailcode: '' });
      for (const browser of browsers) expect(await browser.signedIn()).toBe(true);
    });
  });

  describe('mailings and avatars', () => {
    test('a signed-in user unsubscribes from mailings', async () => {
      const { php } = await runEverywhere(b => b.actor.unsubscribe());
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.actor.flags & 32).toBe(32);
    });
    test('a user uploads an avatar, which is shrunk to fit', async () => {
      const image = await sharp({ create: { width: 800, height: 400, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } }).png().toBuffer();
      const { php } = await runEverywhere(b => b.actor.uploadAvatar(image));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.actor).toMatchObject({ hasavatar: 1, avatarwidth: 400, avatarheight: 200, blobs: 1, jpegBlobs: 1, uploads: 1 });
      expect(php.state.actor.flags & 4).toBe(4);
      expect(php.state.actor.flags & 8).toBe(0);
    });
    test('a new avatar replaces the old one', async () => {
      const image = await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
      const { php } = await runEverywhere(b => b.actor.uploadAvatar(image));
      expect(php.state.actor).toMatchObject({ avatarwidth: 120, avatarheight: 90, blobs: 1, uploads: 1 });
    });
    test('a file that is not an image is refused', async () => {
      const { php, api } = await runEverywhere(b => b.actor.uploadAvatar(Buffer.from('not an image at all')));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'image_not_read' });
    });
    test('the hourly upload limit stops another avatar', async () => {
      const image = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
      const { api } = await withOptions({ max_rate_user_uploads: '0' }, () => runEverywhere(b => b.actor.uploadAvatar(image)));
      expect(api.outcome).toMatchObject({ status: 429, code: 'upload_limit' });
    });
    test('anonymous visitors have no account to save', async () => {
      const { api } = await runEverywhere(b => visitor(b).saveProfile({ handle: 'x' }));
      expect(api.outcome).toMatchObject({ status: 401, code: 'unauthenticated' });
    });
  });
});
