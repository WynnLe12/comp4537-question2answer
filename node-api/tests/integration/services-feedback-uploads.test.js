// The feedback and editor-upload services driven directly, with the repository replaced (and the SMTP
// transport recorded for feedback). Uploads use real images made with sharp.
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const { createFeedbackService } = require('../../src/services/feedback');
const { createUploadService } = require('../../src/services/uploads');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const identify = async token => ({ ok: { id: 5 }, ghost: { id: 99 } }[token] ?? null);

describe('feedback (pages/feedback.php, qa_send_feedback())', () => {
  const sent = [];
  let failing = false;
  beforeAll(() => jest.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: async m => { if (failing) throw new Error('down'); sent.push(m); } })));
  afterAll(() => jest.restoreAllMocks());
  beforeEach(() => { sent.length = 0; failing = false; });
  const OPTIONS = { feedback_enabled: '1', smtp_active: '1', smtp_address: 'mail.test', smtp_port: '25', from_email: 'from@site.test', feedback_email: 'admin@site.test', site_title: 'Site', site_url: 'http://site.test/', neat_urls: '1' };
  const setup = (options = {}, user = { userid: 5, handle: 'ann', level: 0, flags: 0 }) => {
    const fake = fakeRepository({ loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 5 ? user : null) });
    const service = createFeedbackService(fake.repository, { identify });
    return { ...fake, send: (body, token = 'ok', browser = 'Browser/1') => service.sendFeedback({ token, ip: '1.2.3.4', body, browser }) };
  };
  test('the message goes to the feedback address, replying to the sender, with who sent it from where', async () => {
    expect(await setup().send({ message: ' Hello! ', name: ' Ann ', email: 'ann@x.test', referer: 'http://site.test/q/1' })).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    const [m] = sent;
    expect(m).toMatchObject({ from: { name: 'Ann', address: 'from@site.test' }, to: { name: 'Site', address: 'admin@site.test' }, replyTo: { name: 'Ann', address: 'ann@x.test' }, subject: 'Site feedback' });
    for (const part of ['Hello!', 'Ann', 'ann@x.test', 'http://site.test/q/1', 'http://site.test/user/ann', '1.2.3.4', 'Browser/1']) expect(m.text).toContain(part);
  });
  test('missing details show as "-"; an anonymous sender has no profile link; an invalid email gets no reply-to', async () => {
    await setup().send({ message: 'Hi', name: '0', email: 'not-an-email' }, 'none', undefined);
    const [m] = sent;
    expect(m.replyTo).toBeUndefined();
    expect(m.text).not.toContain('http://site.test/user/');
    expect(m.text).toMatch(/-/);
    expect(m.text).toContain('not-an-email');
  });
  test.each([[''], ['0'], ['   '], [undefined]])('message %j is required', async message => {
    await rejectsWith(setup().send({ message }), 400, 'validation_failed', { message: 'required' });
    expect(sent).toEqual([]);
  });
  test('non-text fields are refused', async () => {
    await rejectsWith(setup().send({ message: 'x', email: 5 }), 400, 'invalid_input', { email: 'invalid' });
    await rejectsWith(setup().send(undefined), 400, 'validation_failed');
  });
  test('the form can be switched off, and blocked users cannot use it', async () => {
    await rejectsWith(setup({ feedback_enabled: '' }).send({ message: 'x' }), 404, 'not_found');
    await rejectsWith(setup({}, { userid: 5, handle: 'ann', level: 0, flags: 2 }).send({ message: 'x' }), 403, 'no_permission');
    await rejectsWith(setup({ block_ips_write: '1.2.3.4' }).send({ message: 'x' }, 'none'), 403, 'no_permission');
  });
  test('a captcha is required when configured, except from approved users', async () => {
    const captcha = { captcha_on_feedback: '1', captcha_module: 'reCAPTCHA', recaptcha_public_key: 'p', recaptcha_private_key: 'k' };
    await rejectsWith(setup(captcha).send({ message: 'x' }, 'none'), 400, 'captcha_required');
    await rejectsWith(setup(captcha).send({ message: 'x' }), 400, 'captcha_required');
    await expect(setup(captcha, { userid: 5, handle: 'ann', level: 10, flags: 0 }).send({ message: 'x' })).resolves.toEqual({ sent: true });
    for (const off of ['captcha_on_feedback', 'captcha_module', 'recaptcha_public_key', 'recaptcha_private_key']) {
      await expect(setup({ ...captcha, [off]: '' }).send({ message: 'x' }, 'none')).resolves.toEqual({ sent: true });
    }
  });
  test('a failed email is reported', async () => {
    failing = true;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try { await rejectsWith(setup().send({ message: 'x' }), 503, 'email_failed'); } finally { spy.mockRestore(); }
    await rejectsWith(setup({ smtp_active: '' }).send({ message: 'x' }), 503, 'email_failed');
  });
  test('a session for an account that no longer exists counts as anonymous', async () => {
    await setup().send({ message: 'x' }, 'ghost');
    expect(sent[0].text).not.toContain('http://site.test/user/');
  });
});

describe('editor uploads (qa_upload_file())', () => {
  let png;
  let jpeg;
  let gif;
  beforeAll(async () => {
    png = await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
    jpeg = await sharp({ create: { width: 30, height: 30, channels: 3, background: '#00ff00' } }).jpeg().toBuffer();
    gif = await sharp({ create: { width: 10, height: 12, channels: 3, background: '#0000ff' } }).gif().toBuffer();
  });
  const OPTIONS = { max_rate_user_uploads: '10', max_rate_ip_uploads: '10', site_url: 'http://site.test/' };
  const setup = ({ options = {}, user = { userid: 5, level: 0, flags: 0 }, limits = {}, blobid = '777', cookies = ['123'] } = {}) => {
    const fake = fakeRepository({
      loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 5 ? user : null), findLimits: limits,
      blobCreate: blobid, cookieExists: id => cookies.includes(id), createCookie: '888',
    });
    const service = createUploadService(fake.repository, { identify });
    return { ...fake, service, upload: (request, token = 'ok') => service.upload({ token, ip: '1.2.3.4', filename: 'pic.png', content: png, ...request }) };
  };
  test('an image: its size and real format, stored for the user, with its URL', async () => {
    const s = setup();
    expect(await s.upload({})).toEqual({ result: { width: 40, height: 20, format: 'png', blobid: '777', bloburl: 'http://site.test/?qa=blob&qa_blobid=777' }, cookieid: null, cookieCreated: false });
    const [[, stored]] = s.named('blobCreate');
    expect(stored).toEqual({ content: png, format: 'png', filename: 'pic.png', userid: '5', cookieid: null, ip: '1.2.3.4' });
    expect(s.named('findLimits', 'incrementLimits')).toEqual([['findLimits', '5', '1.2.3.4', 'U'], ['incrementLimits', '5', '1.2.3.4', 'U', 2000]]);
  });
  test('the format comes from the content for images, whatever the extension says', async () => {
    expect((await setup().upload({ filename: 'photo.PNG', content: jpeg })).result).toMatchObject({ format: 'jpg', width: 30, height: 30 });
    expect((await setup().upload({ filename: 'a.jpeg', content: gif })).result).toMatchObject({ format: 'gif', width: 10, height: 12 });
    expect((await setup().upload({ filename: 'dir.v2/a.jpg', content: png })).result.format).toBe('png');
  });
  test('other files keep their extension and are not read as images', async () => {
    expect((await setup().upload({ filename: 'notes.TXT', content: Buffer.from('hello') })).result).toEqual(expect.objectContaining({ format: 'txt', blobid: '777' }));
    expect((await setup().upload({ filename: 'a/b.c\\noext', content: Buffer.from('x') })).result.format).toBe('');
    expect((await setup().upload({ filename: 'trick.png.exe', content: png })).result).not.toHaveProperty('width');
    expect((await setup().upload({ filename: 'broken.png', content: Buffer.from('not an image') })).result).toEqual(expect.objectContaining({ format: 'png' }));
  });
  test('images only: anything that is not a readable image is refused', async () => {
    expect((await setup().upload({ filename: 'a.txt', content: Buffer.from('x'), onlyImage: true })).result).toEqual({ error: 'image_not_read' });
    expect((await setup().upload({ filename: 'a.png', content: Buffer.from('x'), onlyImage: true })).result).toEqual({ error: 'image_not_read' });
    expect((await setup().upload({ onlyImage: true })).result.blobid).toBe('777');
  });
  test('large images shrink to fit, onto white, as JPEG; small ones are kept as they are', async () => {
    const s = setup();
    const { result } = await s.upload({ maxWidth: 20 });
    expect(result).toMatchObject({ format: 'jpg', width: 20, height: 10 });
    const [[, stored]] = s.named('blobCreate');
    expect(stored.format).toBe('jpg');
    const meta = await sharp(stored.content).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 20, height: 10, hasAlpha: false });
    expect((await setup().upload({ maxHeight: 5 })).result).toMatchObject({ width: 10, height: 5 });
    expect((await setup().upload({ maxWidth: '40', maxHeight: '20' })).result).toMatchObject({ format: 'png', width: 40, height: 20 });
    expect((await setup().upload({ maxWidth: '', maxHeight: null })).result.format).toBe('png');
  });
  test('size limits: the request\'s maximum, capped at PHP\'s 2 MB; empty files are refused', async () => {
    expect(setup().service.maxUploadSize()).toBe(2 * 1024 * 1024);
    expect((await setup().upload({ maxSize: 100 })).result).toEqual({ error: 'max_upload_size', maxSize: 100 });
    expect((await setup().upload({ maxSize: png.length })).result.blobid).toBe('777');
    expect((await setup().upload({ maxSize: '99999999', content: Buffer.alloc(2 * 1024 * 1024 + 1), filename: 'a.bin' })).result).toEqual({ error: 'max_upload_size', maxSize: 2 * 1024 * 1024 });
    expect((await setup().upload({ content: Buffer.alloc(0) })).result).toEqual({ error: 'max_upload_size', maxSize: 2 * 1024 * 1024 });
    expect((await setup().upload({ content: 'not a buffer' })).result.error).toBe('max_upload_size');
  });
  test('limits are checked and counted before the file is looked at', async () => {
    const s = setup({ limits: { user: { period: 2000, count: 10 } } });
    expect((await s.upload({})).result).toEqual({ error: 'upload_limit' });
    expect(s.names()).not.toContain('incrementLimits');
    const big = setup();
    await big.upload({ maxSize: 1 });
    expect(big.names()).toContain('incrementLimits');
    expect((await setup({ user: { userid: 5, level: 0, flags: 2 } }).upload({})).result).toEqual({ error: 'no_permission' });
  });
  test('anonymous uploads use the visitor cookie, or a new one', async () => {
    const known = setup();
    expect(await known.upload({ cookieid: '123' }, 'none')).toMatchObject({ cookieid: '123', cookieCreated: false });
    expect(known.named('blobCreate')[0][1]).toMatchObject({ userid: null, cookieid: '123' });
    expect(known.named('findLimits')[0]).toEqual(['findLimits', null, '1.2.3.4', 'U']);
    for (const cookieid of ['456', 'abc', '1'.repeat(21), undefined]) {
      const s = setup();
      expect(await s.upload({ cookieid }, 'none')).toMatchObject({ cookieid: '888', cookieCreated: true });
      expect(s.named('createCookie')).toEqual([['createCookie', '1.2.3.4']]);
    }
  });
  test('a failed store, and a file name over 255 characters', async () => {
    expect((await setup({ blobid: null }).upload({})).result).toEqual({ error: 'general_error' });
    await rejectsWith(setup().upload({ filename: `${'n'.repeat(252)}.png` }), 400, 'validation_failed', { filename: 'too_long' });
    expect((await setup().upload({ filename: `${'n'.repeat(251)}.png` })).result.blobid).toBe('777');
    expect((await setup().upload({ filename: undefined, content: Buffer.from('x') })).result.format).toBe('');
  });
});
