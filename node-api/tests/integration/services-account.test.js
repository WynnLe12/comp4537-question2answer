// Account changes (services/account.js), driven directly with the repository replaced and the SMTP
// transport recorded: profile, password, email confirmation, password reset, unsubscribing and avatars.
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { createHash } = require('node:crypto');
const { createAccountService, FLAGS } = require('../../src/services/account');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const sent = [];
let mailFails = false;
beforeAll(() => jest.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: async m => { if (mailFails) throw new Error('down'); sent.push(m); } })));
afterAll(() => jest.restoreAllMocks());
beforeEach(() => { sent.length = 0; mailFails = false; });

const OPTIONS = { smtp_active: '1', smtp_address: 'acct.test', smtp_port: '25', from_email: 'f@site.test', site_title: 'Site', site_url: 'http://site.test/', neat_urls: '1',
  allow_private_messages: '1', allow_user_walls: '1', mailing_enabled: '1', avatar_store_size: '20', max_rate_user_uploads: '5', max_rate_ip_uploads: '5' };
let ACCOUNT;
beforeAll(async () => {
  ACCOUNT = { userid: '5', handle: 'me', email: 'me@x.test', level: '0', flags: String(FLAGS.EMAIL_CONFIRMED), passhash: await bcrypt.hash('OldPassword', 4), emailcode: 'abc123', avatarblobid: null };
});
function setup({ options = {}, account = ACCOUNT, actor, counts = { qposts: 0, aposts: 0, cposts: 0 }, answers = {} } = {}) {
  const fake = fakeRepository({
    loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 5 ? (actor ?? { userid: 5, level: Number(account.level), flags: Number(account.flags), points: 0 }) : null),
    findAccount: id => (Number(id) === 5 ? account : null), userPostCounts: counts, findUseridsBy: [], userFields: [{ title: 'about' }],
    findAccountByHandle: handle => (handle === 'bob' ? { userid: '8', handle: 'bob', email: 'bob@x.test', emailcode: 'BOBCODE', flags: '0' } : null),
    findUserEmailHandle: { email: account?.email, handle: account?.handle }, findLimits: {}, blobCreate: '555', ...answers,
  });
  const startSession = jest.fn(async (userid, ip) => ({ user: { id: userid }, ip }));
  const service = createAccountService(fake.repository, { identify: async token => (token === 'ok' ? { id: 5 } : token === 'ghost' ? { id: 99 } : null), startSession, saltRounds: 4 });
  const req = (body, token = 'ok') => ({ token, ip: '1.2.3.4', body });
  return { ...fake, service, req, startSession };
}

describe('saving the profile (pages/account.php)', () => {
  test('a new handle and email; the email must be confirmed again, with a confirmation link sent', async () => {
    const s = setup({ options: { confirm_user_emails: '1' } });
    const result = await s.service.saveProfile(s.req({ handle: ' newme ', email: 'new@x.test' }));
    expect(result.errors).toEqual({});
    expect(s.named('userSet').map(c => c.slice(1))).toEqual([[5, 'handle', 'newme'], [5, 'email', 'new@x.test'], ['5', 'emailcode', expect.stringMatching(/^[0-9a-z]{8}$/)]]);
    expect(s.named('userSetFlag')[0]).toEqual(['userSetFlag', 5, FLAGS.EMAIL_CONFIRMED, false]);
    expect(sent).toHaveLength(1);
    expect(sent[0].to.address).toBe('new@x.test');
    const code = s.named('userSet')[2][3];
    expect(sent[0].text).toContain(`http://site.test/confirm?c=${code}&u=newme`);
    expect(s.named('userWritten')).toEqual([['userWritten', 5, '1.2.3.4']]);
  });
  test('without confirmations the new email is saved without a link; experts never confirm', async () => {
    const s = setup();
    await s.service.saveProfile(s.req({ email: 'new@x.test' }));
    expect(sent).toEqual([]);
    const expert = setup({ options: { confirm_user_emails: '1' }, account: { ...ACCOUNT, level: '20' } });
    await expert.service.saveProfile(expert.req({ email: 'new@x.test' }));
    expect(sent).toEqual([]);
  });
  test('the handle can change only before posting, unless changes are allowed', async () => {
    const posted = setup({ counts: { qposts: 1, aposts: 0, cposts: 0 } });
    await posted.service.saveProfile(posted.req({ handle: 'other' }));
    expect(posted.named('userSet')[0]).toEqual(['userSet', 5, 'handle', 'me']);
    const allowed = setup({ counts: { qposts: 0, aposts: 3, cposts: 0 }, options: { allow_change_usernames: '1' } });
    await allowed.service.saveProfile(allowed.req({ handle: 'other' }));
    expect(allowed.named('userSet')[0]).toEqual(['userSet', 5, 'handle', 'other']);
    for (const counts of [{ qposts: 0, aposts: 1, cposts: 0 }, { qposts: 0, aposts: 0, cposts: 1 }]) {
      const s = setup({ counts });
      await s.service.saveProfile(s.req({ handle: 'other' }));
      expect(s.named('userSet')[0][3]).toBe('me');
    }
  });
  test.each([
    [{ handle: '' }, { handle: 'required' }], [{ handle: 'a@b' }, { handle: 'invalid' }], [{ handle: '..' }, { handle: 'invalid' }],
    [{ handle: 'h'.repeat(21) }, { handle: 'max_length' }], [{ handle: 'admin' }, { handle: 'blocked' }],
    [{ email: '' }, { email: 'required' }], [{ email: 'bad' }, { email: 'invalid' }], [{ email: `a@${'d'.repeat(60)}.${'e'.repeat(13)}.test` }, { email: 'max_length' }],
  ])('%j is refused (%j), and the rest still saved', async (body, errors) => {
    const s = setup({ options: { block_bad_usernames: 'admin' } });
    expect((await s.service.saveProfile(s.req({ ...body, profile: { about: 'Hi' } }))).errors).toEqual(errors);
    expect(s.named('profileSet')).toEqual([['profileSet', 5, 'about', 'Hi']]);
  });
  test('a handle or email another user has', async () => {
    const s = setup({ answers: { findUseridsBy: (field) => (field === 'handle' ? [8] : [5, 9]) } });
    expect((await s.service.saveProfile(s.req({ handle: 'bob', email: 'taken@x.test' }))).errors).toEqual({ handle: 'exists', email: 'exists' });
    const own = setup({ answers: { findUseridsBy: [5] } });
    expect((await own.service.saveProfile(own.req({ handle: 'me', email: 'me@x.test' }))).errors).toEqual({});
  });
  test('emoji and control characters are dropped from the handle', async () => {
    const s = setup();
    await s.service.saveProfile(s.req({ handle: 'n\u0007e😀w' }));
    expect(s.named('userSet')[0][3]).toBe('new');
  });
  test('message, wall and mailing switches, each only when that feature is on; avatar choice', async () => {
    const s = setup();
    await s.service.saveProfile(s.req({ messages: false, wallPosts: true, mailings: false, avatar: 'gravatar' }));
    expect(s.named('userSetFlag').map(c => c.slice(2))).toEqual([[FLAGS.NO_MESSAGES, true], [FLAGS.NO_WALL_POSTS, false], [FLAGS.NO_MAILINGS, true], [FLAGS.SHOW_AVATAR, false], [FLAGS.SHOW_GRAVATAR, true]]);
    const off = setup({ options: { allow_private_messages: '', allow_user_walls: '', mailing_enabled: '' } });
    await off.service.saveProfile(off.req({ messages: false }));
    expect(off.named('userSetFlag').map(c => c[2])).toEqual([FLAGS.SHOW_AVATAR, FLAGS.SHOW_GRAVATAR]);
  });
  test('switches left out keep their current value', async () => {
    const flags = FLAGS.EMAIL_CONFIRMED | FLAGS.NO_MESSAGES | FLAGS.SHOW_AVATAR;
    const s = setup({ account: { ...ACCOUNT, flags: String(flags) } });
    await s.service.saveProfile(s.req({}));
    expect(s.named('userSetFlag').map(c => c.slice(2))).toEqual([[FLAGS.NO_MESSAGES, true], [FLAGS.NO_WALL_POSTS, false], [FLAGS.NO_MAILINGS, false], [FLAGS.SHOW_AVATAR, true], [FLAGS.SHOW_GRAVATAR, false]]);
    const grav = setup({ account: { ...ACCOUNT, flags: String(FLAGS.SHOW_GRAVATAR) } });
    await grav.service.saveProfile(grav.req({}));
    expect(grav.named('userSetFlag').slice(-2).map(c => c[3])).toEqual([false, true]);
  });
  test('profile fields: only known ones, text only, at most 8000 characters', async () => {
    const s = setup();
    expect((await s.service.saveProfile(s.req({ profile: { about: 'x'.repeat(8001), other: 'y' } }))).errors).toEqual({ 'profile.about': 'max_length' });
    expect(s.names()).not.toContain('profileSet');
    await rejectsWith(setup().service.saveProfile(s.req({ profile: [] })), 400, 'invalid_input', { profile: 'invalid' });
    await rejectsWith(setup().service.saveProfile(s.req({ profile: { about: 5 } })), 400, 'invalid_input', { about: 'invalid' });
    const ok = setup();
    await ok.service.saveProfile(ok.req({ profile: { about: 'x'.repeat(8000) } }));
    expect(ok.named('profileSet')).toHaveLength(1);
  });
  test('the saved account comes back', async () => {
    const s = setup();
    expect((await s.service.saveProfile(s.req({}))).user).toEqual({ id: 5, handle: 'me', email: 'me@x.test', flags: FLAGS.EMAIL_CONFIRMED });
  });
  test('a blocked user may only correct an unconfirmed email', async () => {
    await rejectsWith(setup({ account: { ...ACCOUNT, flags: '3' } }).service.saveProfile(setup().req({})), 403, 'no_permission');
    const pending = setup({ options: { confirm_user_emails: '1' }, account: { ...ACCOUNT, flags: '2' } });
    await pending.service.saveProfile(pending.req({ handle: 'other', email: 'fixed@x.test', messages: false }));
    expect(pending.named('userSet').map(c => c[2])).toEqual(['email', 'emailcode']);
    expect(pending.named('userSetFlag')).toEqual([['userSetFlag', 5, FLAGS.EMAIL_CONFIRMED, false]]);
    expect(sent[0].text).toContain('u=me');
  });
  test('a failed confirmation email is reported', async () => {
    mailFails = true;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await rejectsWith(setup({ options: { confirm_user_emails: '1' } }).service.saveProfile(setup().req({ email: 'n@x.test' })), 503, 'email_failed'); } finally { spy.mockRestore(); }
  });
  test('signed out, or an account that no longer exists', async () => {
    await rejectsWith(setup().service.saveProfile(setup().req({}, 'none')), 401, 'unauthenticated');
    await rejectsWith(setup().service.saveProfile(setup().req({}, 'ghost')), 401, 'unauthenticated');
  });
});

describe('changing the password', () => {
  test('checks the old one, stores a bcrypt hash, ends PHP\'s remembered logins and other sessions', async () => {
    const s = setup();
    expect(await s.service.changePassword({ token: 'ok', ip: 'ip', body: { oldPassword: 'OldPassword', newPassword: 'NewPassword' } })).toEqual({ changed: true });
    const [[, id, hash]] = s.named('setPasswordHash');
    expect(id).toBe('5');
    expect(await bcrypt.compare('NewPassword', hash)).toBe(true);
    expect(bcrypt.getRounds(hash)).toBe(4);
    expect(s.named('userSet', 'deleteOtherSessions', 'userWritten')).toEqual([
      ['userSet', '5', 'sessioncode', ''], ['deleteOtherSessions', '5', createHash('sha256').update('ok').digest('hex')], ['userWritten', '5', 'ip'],
    ]);
  });
  test('a wrong old password and a short new one are reported together', async () => {
    await rejectsWith(setup().service.changePassword({ token: 'ok', body: { oldPassword: 'wrong', newPassword: 'short' } }), 400, 'validation_failed', { oldPassword: 'wrong', newPassword: 'too_short' });
    await rejectsWith(setup().service.changePassword({ token: 'ok', body: {} }), 400, 'validation_failed', { oldPassword: 'wrong', newPassword: 'too_short' });
  });
  test('an account without a password (external login) needs no old one; 8 characters are enough', async () => {
    const s = setup({ account: { ...ACCOUNT, passhash: null, passsalt: null, passcheck: null } });
    await s.service.changePassword({ token: 'ok', body: { newPassword: '12345678' } });
    expect(s.names()).toContain('setPasswordHash');
  });
  test('a legacy salted password counts as having one', async () => {
    const salt = 'abcdefgh12345678';
    const passcheck = createHash('sha1').update(`${salt.slice(0, 8)}Legacy99${salt.slice(8)}`).digest();
    await rejectsWith(setup({ account: { ...ACCOUNT, passhash: null, passsalt: salt, passcheck } }).service.changePassword({ token: 'ok', body: { newPassword: '12345678' } }), 400, 'validation_failed', { oldPassword: 'wrong' });
    await setup({ account: { ...ACCOUNT, passhash: null, passsalt: salt, passcheck } }).service.changePassword({ token: 'ok', body: { oldPassword: 'Legacy99', newPassword: '12345678' } });
  });
});

describe('email confirmation (pages/confirm.php)', () => {
  test('sending a new link', async () => {
    const s = setup();
    expect(await s.service.sendConfirmation(s.req({}))).toEqual({ sent: true });
    expect(sent[0].to.address).toBe('me@x.test');
  });
  test('a code for the named user confirms them, case-insensitively, signed in or not', async () => {
    const s = setup();
    expect(await s.service.confirmEmail(s.req({ code: ' bobcode ', handle: 'bob' }, 'none'))).toEqual({ confirmed: true });
    expect(s.named('userSetFlag', 'userSet')).toEqual([
      ['userSetFlag', '8', FLAGS.EMAIL_CONFIRMED, true], ['userSetFlag', '8', FLAGS.MUST_CONFIRM, false], ['userSet', '8', 'emailcode', ''],
    ]);
  });
  test('otherwise the signed-in user\'s own code; an already confirmed user is fine', async () => {
    const unconfirmed = setup({ account: { ...ACCOUNT, flags: '0' } });
    expect(await unconfirmed.service.confirmEmail(unconfirmed.req({ code: 'ABC123', handle: 'bob' }))).toEqual({ confirmed: true });
    expect(unconfirmed.named('userSetFlag')[0]).toEqual(['userSetFlag', '5', FLAGS.EMAIL_CONFIRMED, true]);
    const confirmed = setup();
    expect(await confirmed.service.confirmEmail(confirmed.req({ code: 'anything' }))).toEqual({ confirmed: true });
    expect(confirmed.names()).not.toContain('userSetFlag');
    // confirmed but asked to confirm again
    const must = setup({ account: { ...ACCOUNT, flags: String(FLAGS.EMAIL_CONFIRMED | FLAGS.MUST_CONFIRM) } });
    await rejectsWith(must.service.confirmEmail(must.req({ code: 'wrong' })), 400, 'invalid_code');
  });
  test('a missing or wrong code', async () => {
    await rejectsWith(setup().service.confirmEmail(setup().req({ code: '  ' })), 400, 'validation_failed', { code: 'required' });
    await rejectsWith(setup().service.confirmEmail(setup().req({ code: 'wrong', handle: 'bob' }, 'none')), 400, 'invalid_code');
    await rejectsWith(setup().service.confirmEmail(setup().req({ code: 'x', handle: 'nobody' }, 'none')), 400, 'invalid_code');
  });
});

describe('password reset (pages/forgot.php, pages/reset.php)', () => {
  test('a code is emailed to the user found by email or handle', async () => {
    const s = setup({ account: null, answers: { findUseridsBy: (field, value) => ((field === 'handle' && value === 'me') || (field === 'email' && value === 'me@x.test') ? [5] : []), findAccount: { ...ACCOUNT } } });
    expect(await s.service.startPasswordReset(s.req({ emailHandle: 'me' }, 'none'))).toEqual({ sent: true });
    const code = s.named('userSet')[0][3];
    expect(s.named('userSet')[0]).toEqual(['userSet', 5, 'emailcode', expect.stringMatching(/^[0-9a-z]{8}$/)]);
    expect(sent[0].text).toContain(`http://site.test/reset?c=${code}&e=me%40x.test`);
    await s.service.startPasswordReset(s.req({ emailHandle: 'me@x.test' }, 'none'));
    expect(s.named('findUseridsBy').map(c => c[1])).toEqual(['handle', 'email']);
  });
  test('with logins by email only, a handle finds nobody', async () => {
    const s = setup({ account: null, options: { allow_login_email_only: '1' }, answers: { findUseridsBy: [5] } });
    await rejectsWith(s.service.startPasswordReset(s.req({ emailHandle: 'me' }, 'none')), 404, 'user_not_found');
  });
  test.each([
    ['signed in', {}, 'ok', 403, 'already_logged_in'],
    ['no such user', { answers: { findUseridsBy: [] } }, 'none', 404, 'user_not_found'],
    ['two matching users', { answers: { findUseridsBy: [5, 6] } }, 'none', 404, 'user_not_found'],
    ['a captcha required', { answers: { findUseridsBy: [5] }, options: { captcha_on_reset_password: '1', captcha_module: 'r', recaptcha_public_key: 'p', recaptcha_private_key: 'k' } }, 'none', 400, 'captcha_required'],
  ])('starting refused: %s', async (label, args, token, status, code) => {
    await rejectsWith(setup(args).service.startPasswordReset(setup().req({ emailHandle: 'me' }, token)), status, code);
  });
  test('a failed reset email', async () => {
    mailFails = true;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await rejectsWith(setup({ answers: { findUseridsBy: [5] } }).service.startPasswordReset(setup().req({ emailHandle: 'me' }, 'none')), 503, 'email_failed'); } finally { spy.mockRestore(); }
  });
  test('finishing: the right code sets the password, clears the code and signs the user in', async () => {
    const s = setup({ answers: { findUseridsBy: [5] } });
    expect(await s.service.finishPasswordReset({ token: 'none', ip: 'ip', body: { emailHandle: ' me ', code: ' ABC123 ', newPassword: 'Brand-new1' } })).toEqual({ user: { id: 5 }, ip: 'ip' });
    expect(await bcrypt.compare('Brand-new1', s.named('setPasswordHash')[0][2])).toBe(true);
    expect(s.named('userSet')).toEqual([['userSet', 5, 'emailcode', '']]);
    expect(s.startSession).toHaveBeenCalledWith(5, 'ip');
  });
  test('on the reset page a handle with "@"-less logins still finds the user when email-only logins are on', async () => {
    const s = setup({ options: { allow_login_email_only: '1' }, answers: { findUseridsBy: [5] } });
    await s.service.finishPasswordReset({ token: 'none', body: { emailHandle: 'me', code: 'abc123', newPassword: 'Brand-new1' } });
    expect(s.named('findUseridsBy')[0][1]).toBe('email');
  });
  test.each([
    ['a wrong code', { emailHandle: 'me', code: 'nope', newPassword: 'Brand-new1' }, 400, 'invalid_code'],
    ['an empty code', { emailHandle: 'me', code: ' ', newPassword: 'Brand-new1' }, 400, 'invalid_code'],
    ['no email or handle', { code: 'abc123', newPassword: 'Brand-new1' }, 400, 'invalid_code'],
    ['a short password', { emailHandle: 'me', code: 'abc123', newPassword: 'short' }, 400, 'validation_failed'],
  ])('finishing refused: %s', async (label, body, status, code) => {
    const s = setup({ answers: { findUseridsBy: [5] } });
    await rejectsWith(s.service.finishPasswordReset({ token: 'none', body }), status, code);
    expect(s.names()).not.toContain('setPasswordHash');
    expect(s.startSession).not.toHaveBeenCalled();
  });
  test('an account with no code is never matched by an empty one', async () => {
    const s = setup({ account: { ...ACCOUNT, emailcode: '' }, answers: { findUseridsBy: [5] } });
    await rejectsWith(s.service.finishPasswordReset({ token: 'none', body: { emailHandle: 'me', code: '', newPassword: 'Brand-new1' } }), 400, 'invalid_code');
    await rejectsWith(setup().service.finishPasswordReset({ token: 'ok', body: {} }), 403, 'already_logged_in');
  });
});

describe('unsubscribing (pages/unsubscribe.php)', () => {
  test('the signed-in user, or the user named in the link with its code', async () => {
    const s = setup();
    expect(await s.service.unsubscribe(s.req({}))).toEqual({ unsubscribed: true });
    expect(s.named('userSetFlag')).toEqual([['userSetFlag', '5', FLAGS.NO_MAILINGS, true]]);
    const link = setup();
    await link.service.unsubscribe(link.req({ handle: 'bob', code: ' bobcode ' }, 'none'));
    expect(link.named('userSetFlag')).toEqual([['userSetFlag', '8', FLAGS.NO_MAILINGS, true]]);
    await rejectsWith(setup().service.unsubscribe(setup().req({ handle: 'bob', code: 'wrong' }, 'none')), 400, 'invalid_code');
    await rejectsWith(setup().service.unsubscribe(setup().req({ code: 'x' }, 'none')), 400, 'invalid_code');
  });
});

describe('avatar upload', () => {
  let wide;
  beforeAll(async () => { wide = await sharp({ create: { width: 40, height: 10, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.3 } } }).png().toBuffer(); });
  test('resized to fit, stored as JPEG, shown instead of a Gravatar, and the old one deleted', async () => {
    const s = setup({ account: { ...ACCOUNT, avatarblobid: '111' } });
    expect(await s.service.uploadAvatar({ token: 'ok', ip: 'ip', image: wide })).toEqual({ avatar: { blobid: '555', width: 20, height: 5 } });
    const [[, data, format, userid, ip]] = s.named('blobCreate');
    expect([format, userid, ip]).toEqual(['jpeg', '5', 'ip']);
    expect(await sharp(data).metadata()).toMatchObject({ format: 'jpeg', width: 20, height: 5 });
    expect(s.named('incrementLimits', 'setAvatar', 'userSetFlag', 'blobDelete')).toEqual([
      ['incrementLimits', '5', 'ip', 'U', 2000], ['setAvatar', '5', '555', 20, 5], ['userSetFlag', '5', FLAGS.SHOW_AVATAR, true], ['userSetFlag', '5', FLAGS.SHOW_GRAVATAR, false], ['blobDelete', '111'],
    ]);
  });
  test('a small image keeps its size; no old avatar means nothing to delete', async () => {
    const s = setup({ options: { avatar_store_size: '100' } });
    expect((await s.service.uploadAvatar({ token: 'ok', image: wide })).avatar).toMatchObject({ width: 40, height: 10 });
    expect(s.names()).not.toContain('blobDelete');
  });
  test('refusals: no image, over the limit, blocked, unreadable (still counted), not stored', async () => {
    await rejectsWith(setup().service.uploadAvatar({ token: 'ok', image: Buffer.alloc(0) }), 400, 'validation_failed', { image: 'required' });
    await rejectsWith(setup().service.uploadAvatar({ token: 'ok', image: 'x' }), 400, 'validation_failed');
    await rejectsWith(setup({ answers: { findLimits: { user: { period: 2000, count: 5 } } } }).service.uploadAvatar({ token: 'ok', image: wide }), 429, 'upload_limit');
    await rejectsWith(setup({ actor: { userid: 5, level: 0, flags: 2 } }).service.uploadAvatar({ token: 'ok', image: wide }), 403, 'no_permission');
    const bad = setup();
    await rejectsWith(bad.service.uploadAvatar({ token: 'ok', image: Buffer.from('not an image') }), 400, 'image_not_read');
    expect(bad.names()).toContain('incrementLimits');
    await rejectsWith(setup({ answers: { blobCreate: null } }).service.uploadAvatar({ token: 'ok', image: wide }), 400, 'image_not_read');
  });
});
