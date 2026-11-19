// Editor upload parity: the original PHP site and the shared UI receive files through the WYSIWYG
// editor's upload page (qa-plugin/wysiwyg-editor/qa-wysiwyg-upload.php → qa_upload_file()), and the Node
// API receives them directly with the page's settings. The editor's reply (URL or message), the blob
// stored (format, file name, owner, visitor cookie, address and content), the upload rate limits and
// any new visitor cookie must match.
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const sharp = require('sharp');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, API_URL, siteDriver, apiDriver, limitRows, limitDelta } = require('./post-helpers');

// qa_js() strings in the editor's callback script.
const unjs = literal => literal.slice(1, -1).replace(/\\(.)/g, (m, c) => ({ n: '\n', r: '\r' }[c] ?? c));
function editorReply(html) {
  const match = /callFunction\(([^,]*), ('(?:[^'\\]|\\.)*'), ('(?:[^'\\]|\\.)*')\);/.exec(html);
  if (!match) throw new Error(`No editor callback in: ${html.slice(0, 300)}`);
  return { url: unjs(match[2]), message: unjs(match[3]) };
}
const visitorCookieOf = response => (response.headers['set-cookie'] ?? []).map(c => /^qa_id=(\d+);/.exec(c)?.[1]).find(Boolean) ?? null;

describe('PHP ↔ Node editor upload parity (original page, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends, files;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    files = {
      smallPng: await sharp({ create: { width: 40, height: 30, channels: 4, background: { r: 200, g: 10, b: 10, alpha: 0.5 } } }).png().toBuffer(),
      bigPng: await sharp({ create: { width: 1200, height: 800, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 0.4 } } }).png().toBuffer(),
      tallGif: await sharp({ create: { width: 300, height: 900, channels: 3, background: { r: 0, g: 160, b: 0 } } }).gif().toBuffer(),
      jpeg: await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 250, g: 200, b: 0 } } }).jpeg({ quality: 80 }).toBuffer(),
      text: Buffer.from(`Notes for ${suffix}\nline two\n`),
      broken: Buffer.from('this is not really a png'),
    };
    backends = [];
    for (const [tag, make] of [
      ['p', () => siteDriver('php', PHP_URL, phpPool)],
      ['u', () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', () => apiDriver(nodePool)],
    ]) {
      const users = { member: make(), limited: make() };
      const handles = Object.fromEntries(Object.keys(users).map(label => [label, `up${label.slice(0, 3)}${tag}${suffix}`]));
      for (const label of Object.keys(users)) await users[label].register(handles[label]);
      const ids = {};
      for (const label of Object.keys(users)) {
        const [[row]] = await users[label].pool.execute('SELECT userid FROM qa_users WHERE handle=?', [handles[label]]);
        ids[label] = String(row.userid);
      }
      backends.push({ tag, users, handles, ids, pool: users.member.pool, kind: tag === 'n' ? 'api' : 'site', baseUrl: tag === 'p' ? PHP_URL : UI_URL });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

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
  // Uploads on, any file type, the page's 1 MB size limit, and IP limits out of the way.
  const SETTINGS = { wysiwyg_editor_upload_images: '1', wysiwyg_editor_upload_all: '1', wysiwyg_editor_upload_max_size: '1048576', max_rate_ip_uploads: '100000', max_rate_user_uploads: '1000' };

  // Uploads a file as the editor would: { onlyImage } is the page's qa_only_image (images go in at most 600px wide).
  async function upload(backend, who, file, name, { onlyImage = false } = {}) {
    const options = Object.fromEntries((await backend.pool.query("SELECT title, content FROM qa_options WHERE title LIKE 'wysiwyg_editor_upload%'"))[0].map(r => [r.title, r.content]));
    let response;
    if (backend.kind === 'site') {
      const client = who === 'anonymous' ? request.agent(backend.baseUrl) : backend.users[who]._client;
      response = await client.post(`/index.php?qa=wysiwyg-editor-upload&CKEditorFuncNum=7${onlyImage ? '&qa_only_image=1' : ''}`).attach('upload', file, name);
      const reply = editorReply(response.text);
      return { ...reply, blobid: new URL(reply.url || 'http://x/').searchParams.get('qa_blobid'), backend: response.headers['x-q2a-upload-backend'], cookie: visitorCookieOf(response) };
    }
    // The API with the settings the editor page passes to qa_upload_file().
    if (!Number(options.wysiwyg_editor_upload_images)) return { url: '', message: 'no_permission', blobid: null, cookie: null };
    const client = who === 'anonymous' ? request.agent(API_URL) : backend.users[who]._client;
    const query = new URLSearchParams({ name, maxSize: options.wysiwyg_editor_upload_max_size ?? '' });
    if (onlyImage || !Number(options.wysiwyg_editor_upload_all)) query.set('onlyImage', '1');
    if (onlyImage) query.set('maxWidth', '600');
    response = await client.post(`/api/v1/uploads?${query}`).set('X-Q2A-Request', '1').set('Content-Type', 'application/octet-stream').send(file);
    return response.status === 201
      ? { url: response.body.upload.bloburl, message: '', blobid: response.body.upload.blobid, cookie: visitorCookieOf(response), result: response.body.upload }
      : { url: '', message: response.body.error.code, maxSize: response.body.error.maxSize, blobid: null, cookie: visitorCookieOf(response) };
  }

  async function blobState(backend, blobid, who, cookie) {
    if (!blobid) return null;
    const [[blob]] = await backend.pool.query('SELECT format, filename, userid, cookieid, INET6_NTOA(createip) AS ip, content FROM qa_blobs WHERE blobid=?', [blobid]);
    if (!blob) return 'missing';
    const image = await sharp(blob.content).metadata().then(m => `${m.format} ${m.width}x${m.height}`).catch(() => 'not an image');
    return {
      format: blob.format, filename: blob.filename,
      owner: blob.userid === null ? null : Object.entries(backend.ids).find(([, id]) => id === String(blob.userid))?.[0] ?? 'other',
      cookie: blob.cookieid === null ? 'none' : cookie && String(blob.cookieid) === cookie ? 'new visitor cookie' : 'other cookie',
      ip: blob.ip, image, content: blob.content,
    };
  }
  const limitsOf = (backend, userid) => Promise.all([
    limitRows(backend.pool, "SELECT userid AS k, period, count FROM qa_userlimits WHERE action='U' AND userid=?", [userid ?? 0]),
    limitRows(backend.pool, "SELECT HEX(ip) AS k, period, count FROM qa_iplimits WHERE action='U'"),
  ]);

  // Runs one upload everywhere and compares; `expectContent` is the stored bytes when the file is kept as is.
  // A shrunk image is re-encoded (GD in PHP, sharp in Node), so its bytes differ: it is compared by its
  // format, size and average colour (the white behind transparency included) instead.
  const meanColour = async content => (await sharp(content).stats()).channels.slice(0, 3).map(c => c.mean);
  async function comparableBlob(blob, resized) {
    if (!blob || typeof blob !== 'object' || !resized) return blob;
    const { content, ...rest } = blob;
    return { ...rest, colour: await meanColour(content) };
  }
  async function runEverywhere(who, file, name, opts = {}) {
    const results = [];
    for (const backend of backends) {
      const userid = who === 'anonymous' ? null : backend.ids[who];
      const before = await limitsOf(backend, userid);
      const outcome = await upload(backend, who, file, name, opts);
      const after = await limitsOf(backend, userid);
      const blob = await blobState(backend, outcome.blobid, who, outcome.cookie);
      results.push({ backend, outcome, blob, limits: { user: limitDelta(before[0], after[0]), ip: limitDelta(before[1], after[1]) } });
    }
    const [php, ui, api] = results;
    expect(ui.outcome.message).toBe(php.outcome.message);
    expect(Boolean(ui.outcome.url)).toBe(Boolean(php.outcome.url));
    expect(Boolean(api.outcome.url)).toBe(Boolean(php.outcome.url));
    expect(ui.limits).toEqual(php.limits);
    expect(api.limits).toEqual(php.limits);
    const [phpBlob, uiBlob, apiBlob] = await Promise.all([php, ui, api].map(r => comparableBlob(r.blob, opts.resized)));
    if (opts.resized && phpBlob && typeof phpBlob === 'object') {
      for (const other of [uiBlob, apiBlob]) {
        other.colour.forEach((value, i) => expect(Math.abs(value - phpBlob.colour[i])).toBeLessThanOrEqual(3));
        other.colour = phpBlob.colour;
      }
    }
    expect(uiBlob).toEqual(phpBlob);
    expect(apiBlob).toEqual(phpBlob);
    expect(Boolean(ui.outcome.cookie)).toBe(Boolean(php.outcome.cookie));
    expect(Boolean(api.outcome.cookie)).toBe(Boolean(php.outcome.cookie));
    if (php.outcome.url) {
      expect(ui.outcome.backend).toBe('node-api-v1');
      expect(new URL(ui.outcome.url).searchParams.get('qa')).toBe('blob');
      expect(new URL(api.outcome.url).searchParams.get('qa_blobid')).toBe(api.outcome.blobid);
    }
    return { php, ui, api };
  }

  test('a member adds a small image: stored exactly as sent', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.smallPng, `dot ${suffix}.png`, { onlyImage: true });
    expect(php.outcome.message).toBe('');
    expect(php.blob).toMatchObject({ format: 'png', owner: 'member', image: 'png 40x30' });
    expect(Buffer.compare(php.blob.content, files.smallPng)).toBe(0);
    expect(php.limits).toEqual({ user: 1, ip: 1 });
  }));

  test('a wide image is shrunk to 600px as a JPEG', () => withOptions(SETTINGS, async () => {
    const { php, ui, api } = await runEverywhere('member', files.bigPng, `wide-${suffix}.PNG`, { onlyImage: true, resized: true });
    expect(php.blob).toMatchObject({ format: 'jpg', image: 'jpeg 600x400' });
    expect(api.outcome.result).toMatchObject({ format: 'jpg', width: 600, height: 400 });
    expect(ui.blob.content.length).toBeGreaterThan(0);
  }));

  test('a tall image is not shrunk (only the width is limited)', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.tallGif, `tall ${suffix}.gif`, { onlyImage: true });
    expect(php.blob).toMatchObject({ format: 'gif', image: 'gif 300x900' });
    expect(Buffer.compare(php.blob.content, files.tallGif)).toBe(0);
  }));

  test('the real image type wins over the extension', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.jpeg, `photo-${suffix}.png`);
    expect(php.blob).toMatchObject({ format: 'jpg', image: 'jpeg 64x48' });
  }));

  test('any file can be attached when the editor allows all files', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.text, `notes-${suffix}.TXT`);
    expect(php.blob).toMatchObject({ format: 'txt', filename: `notes-${suffix}.TXT`, image: 'not an image' });
    expect(Buffer.compare(php.blob.content, files.text)).toBe(0);
  }));

  test('a file with no extension keeps an empty format', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.text, `README${suffix}`);
    expect(php.blob).toMatchObject({ format: '' });
  }));

  test('only images are accepted when the editor allows only images', () => withOptions({ ...SETTINGS, wysiwyg_editor_upload_all: '0' }, async () => {
    const { php } = await runEverywhere('member', files.text, `notes-${suffix}.txt`);
    expect(php.outcome.message).toMatch(/GIF, JPG, PNG/);
    expect(php.limits).toEqual({ user: 1, ip: 1 }); // the attempt still counts
  }));

  test('a broken image is refused for the image button', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.broken, `fake-${suffix}.png`, { onlyImage: true });
    expect(php.outcome.message).toMatch(/GIF, JPG, PNG/);
  }));

  test('a broken image with an image extension is kept as a file when all files are allowed', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('member', files.broken, `fake-${suffix}.jpeg`);
    expect(php.blob).toMatchObject({ format: 'jpeg', image: 'not an image' });
  }));

  test('a file over the size limit is refused', () => withOptions({ ...SETTINGS, wysiwyg_editor_upload_max_size: '1000' }, async () => {
    const { php, api } = await runEverywhere('member', files.bigPng, `huge-${suffix}.png`, { onlyImage: true });
    expect(php.outcome.message).toBe('Maximum upload size is 0.0MB');
    expect(api.outcome).toMatchObject({ message: 'max_upload_size', maxSize: 1000 });
  }));

  test('anonymous visitors get a visitor cookie tied to their upload', () => withOptions(SETTINGS, async () => {
    const { php } = await runEverywhere('anonymous', files.smallPng, `anon-${suffix}.png`, { onlyImage: true });
    expect(php.blob).toMatchObject({ owner: null, cookie: 'new visitor cookie' });
    expect(php.limits).toEqual({ user: 0, ip: 1 });
  }));

  test('the hourly upload limit stops another upload', () => withOptions({ ...SETTINGS, max_rate_user_uploads: '1' }, async () => {
    const first = await runEverywhere('limited', files.smallPng, `one-${suffix}.png`, { onlyImage: true });
    expect(first.php.outcome.message).toBe('');
    const second = await runEverywhere('limited', files.smallPng, `two-${suffix}.png`, { onlyImage: true });
    expect(second.php.outcome.message).toBe('Too many uploads - please try again in an hour');
    expect(second.php.limits).toEqual({ user: 0, ip: 0 });
  }));

  test('uploads are refused while the editor has them switched off', () => withOptions({ ...SETTINGS, wysiwyg_editor_upload_images: '0' }, async () => {
    const results = [];
    for (const backend of backends.slice(0, 2)) results.push(await upload(backend, 'member', files.smallPng, `off-${suffix}.png`, { onlyImage: true }));
    expect(results[1].message).toBe(results[0].message);
    expect(results[0].url).toBe('');
  }));

  test('the API needs the request header', async () => {
    const res = await request(API_URL).post('/api/v1/uploads?name=a.png').set('Content-Type', 'application/octet-stream').send(files.smallPng);
    expect(res.status).toBe(403);
  });
});
