// Known, deliberate differences between the original PHP site and the shared UI, pinned down so a change
// on either side is noticed. Each is listed in the migration notes.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver } = require('../parity/post-helpers');

const run = process.env.RELIABILITY === '1' ? describe : describe.skip;

run('Known differences between the PHP site and the shared UI', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool;
  beforeAll(() => { phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' }); nodePool = createPool(); });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  // pages/message.php and pages/user-wall.php pass the text straight to MySQL, which refuses characters
  // outside the Basic Multilingual Plane in the utf8mb3 columns: PHP stops with a fatal error and nothing
  // is stored. Node drops those characters (qa_remove_utf8mb4(), as Q2A does for posts) and stores the rest.
  test.each([
    ['private message', (d, to, text) => d.sendMessage(to, text), "SELECT content FROM qa_messages WHERE type='PRIVATE' AND content LIKE ?"],
    ['wall post', (d, to, text) => d.wallPost(to, text), "SELECT content FROM qa_messages WHERE type='PUBLIC' AND content LIKE ?"],
  ])('an emoji in a %s: PHP fails, Node stores the text without it', async (label, send, sql) => {
    const results = [];
    for (const [name, url, pool, tag] of [['php', PHP_URL, phpPool, 'p'], ['migrated-ui', UI_URL, nodePool, 'u']]) {
      const sender = siteDriver(name, url, pool);
      const recipient = siteDriver(name, url, pool);
      await sender.register(`kd${tag}${label[0]}s${suffix}`);
      await recipient.register(`kd${tag}${label[0]}r${suffix}`);
      const text = `Hello ${suffix}${label[0]} 🙂 there`;
      const outcome = await send(sender, `kd${tag}${label[0]}r${suffix}`, text);
      const [rows] = await pool.query(sql, [`Hello ${suffix}${label[0]}%`]);
      results.push({ outcome, stored: rows.map(r => r.content) });
    }
    const [php, ui] = results;
    expect(php.outcome.accepted).toBe(false);
    expect(php.stored).toEqual([]);
    expect(ui.outcome.accepted).toBe(true);
    expect(ui.stored).toEqual([`Hello ${suffix}${label[0]}  there`]);
  });
});
