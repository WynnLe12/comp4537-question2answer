// Read parity: every db/selects.php builder the shared UI now sends to Node is run both ways against the
// same database: through PHP's own builders and qa_db_single_select (docker/php/read-harness.php on the
// shared UI, with the bridge switched off) and through the Node API's internal reads. Results, their
// keys, their order and every byte of every value must match. The shared UI's pages are also loaded to
// check they render from Node's reads.
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { createPool } = require('../../src/db');
const { UI_URL, API_URL, siteDriver } = require('./post-helpers');

const KEY = process.env.BRIDGE_SECRET;

// Both sides as base64 bytes: the harness encodes every value, Node only binary ones.
function bytes(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
  if (typeof value === 'object' && Object.keys(value).length === 1 && typeof value.b64 === 'string') return value.b64;
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bytes(v)]));
  return Buffer.from(String(value), 'utf8').toString('base64');
}
const normalise = result => (result.single
  ? { single: true, value: bytes(result.value) }
  : { single: false, entries: result.entries.map(([k, v]) => [String(k), bytes(v)]) });

async function runReads(url, reads) {
  const res = await request(url).post('').set('X-Q2A-Bridge-Key', KEY).send({ reads });
  if (res.status !== 200) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.results;
}

// [label, builder, args(fixtures), count?]
const CASES = [
  ['options', 'qa_db_options_selectspec', () => []],
  ['recent questions', 'qa_db_qs_selectspec', f => [null, 'created', 0, null, null, false, false, 20]],
  ['hot questions with votes, full', 'qa_db_qs_selectspec', f => [f.voter, 'hotness', 0, null, null, false, true, 10]],
  ['questions by votes, offset', 'qa_db_qs_selectspec', f => [null, 'netvotes', 5, null, null, false, false, 10]],
  ['questions by views in a category', 'qa_db_qs_selectspec', f => [f.voter, 'views', 0, f.catslugs, null, false, false, 10]],
  ['questions from an ip', 'qa_db_qs_selectspec', f => [null, 'created', 0, null, f.ip, true, false, 10]],
  ['question count', 'qa_db_qs_selectspec', f => [null, 'created', 0, null, null, false, false, 20], true],
  ['unanswered', 'qa_db_unanswered_qs_selectspec', f => [f.voter, null, 0, null, false, false, 20]],
  ['unselected', 'qa_db_unanswered_qs_selectspec', f => [null, 'selchildid', 0, null, false, true, 10]],
  ['unupvoted in a category', 'qa_db_unanswered_qs_selectspec', f => [null, 'amaxvote', 0, f.catslugs, false, false, 10]],
  ['recent answers', 'qa_db_recent_a_qs_selectspec', f => [f.voter, 0, null, null, false, true, 15]],
  ['recent answers from an ip', 'qa_db_recent_a_qs_selectspec', f => [null, 0, null, f.ip, true, false, 15]],
  ['recent comments', 'qa_db_recent_c_qs_selectspec', f => [f.voter, 0, null, null, false, true, 15]],
  ['recent edits', 'qa_db_recent_edit_qs_selectspec', f => [f.voter, 0, null, null, true, true, 15]],
  ['recent edits incl. hidden', 'qa_db_recent_edit_qs_selectspec', f => [null, 0, null, f.ip, false, false, 15]],
  ['flagged', 'qa_db_flagged_post_qs_selectspec', f => [f.voter, 0, true, 20]],
  ['posts', 'qa_db_posts_selectspec', f => [f.voter, f.postids, true]],
  ['posts basetype', 'qa_db_posts_basetype_selectspec', f => [f.postids]],
  ['posts to questions', 'qa_db_posts_to_qs_selectspec', f => [f.voter, f.postids, true]],
  ['full post', 'qa_db_full_post_selectspec', f => [f.voter, f.q]],
  ['full post, missing', 'qa_db_full_post_selectspec', f => [null, 999999999]],
  ['child posts', 'qa_db_full_child_posts_selectspec', f => [f.voter, f.q]],
  ['answer child posts', 'qa_db_full_a_child_posts_selectspec', f => [f.voter, f.q]],
  ['parent question', 'qa_db_post_parent_q_selectspec', f => [f.c]],
  ['close post', 'qa_db_post_close_post_selectspec', f => [f.closedq]],
  ['duplicates', 'qa_db_post_duplicates_selectspec', f => [f.dupof]],
  ['post meta', 'qa_db_post_meta_selectspec', f => [f.q, f.metatitle]],
  ['post meta list', 'qa_db_post_meta_selectspec', f => [f.q, [f.metatitle, 'qa_q_other']]],
  ['related', 'qa_db_related_qs_selectspec', f => [f.voter, f.q, 10]],
  ['search', 'qa_db_search_posts_selectspec', f => [f.voter, f.words, f.words, f.tagwords, [f.handle], f.handle, 0, true, 10]],
  ['search, no handle', 'qa_db_search_posts_selectspec', f => [null, f.words, [], [], [], null, 0, false, 10]],
  ['category by slugs', 'qa_db_full_category_selectspec', f => [f.catslugs, false]],
  ['category by id', 'qa_db_full_category_selectspec', f => [f.childcat, true]],
  ['category nav by slugs', 'qa_db_category_nav_selectspec', f => [f.catslugs, false, false, true]],
  ['category nav by id', 'qa_db_category_nav_selectspec', f => [f.childcat, true, false, false]],
  ['category nav by post', 'qa_db_category_nav_selectspec', f => [f.q, true, true, true]],
  ['top category nav', 'qa_db_category_nav_selectspec', f => [null, true, false, true]],
  ['subcategories', 'qa_db_category_sub_selectspec', f => [f.parentcat]],
  ['slugs to category', 'qa_db_slugs_to_category_id_selectspec', f => [f.catslugs]],
  ['pages', 'qa_db_pages_selectspec', () => []],
  ['nav pages', 'qa_db_pages_selectspec', () => [['M', 'O', 'F', 'B'], null]],
  ['widgets', 'qa_db_widgets_selectspec', () => []],
  ['page by slug', 'qa_db_page_full_selectspec', f => [f.pageslug, false]],
  ['page by id', 'qa_db_page_full_selectspec', f => [f.pageid, true]],
  ['tag questions', 'qa_db_tag_recent_qs_selectspec', f => [f.voter, f.tag, 0, true, 10]],
  ['tag word', 'qa_db_tag_word_selectspec', f => [f.tag]],
  ['user questions', 'qa_db_user_recent_qs_selectspec', f => [f.voter, f.handle, 10]],
  ['user answers', 'qa_db_user_recent_a_qs_selectspec', f => [f.voter, f.handle, 10]],
  ['user comments', 'qa_db_user_recent_c_qs_selectspec', f => [f.voter, f.handle, 10]],
  ['user edits', 'qa_db_user_recent_edit_qs_selectspec', f => [f.voter, f.handle, 10]],
  ['popular tags', 'qa_db_popular_tags_selectspec', () => [0, 30]],
  ['popular tags, offset', 'qa_db_popular_tags_selectspec', () => [10, 10]],
  ['user fields', 'qa_db_userfields_selectspec', () => []],
  ['account by id', 'qa_db_user_account_selectspec', f => [f.user, true]],
  ['account by handle', 'qa_db_user_account_selectspec', f => [f.handle, false]],
  ['profile', 'qa_db_user_profile_selectspec', f => [f.user, true]],
  ['notices', 'qa_db_user_notices_selectspec', f => [f.user]],
  ['points', 'qa_db_user_points_selectspec', f => [f.handle]],
  ['points by id', 'qa_db_user_points_selectspec', f => [f.user, true]],
  ['rank', 'qa_db_user_rank_selectspec', f => [f.handle]],
  ['top users', 'qa_db_top_users_selectspec', () => [0, 20]],
  ['newest users', 'qa_db_newest_users_selectspec', () => [0, 20]],
  ['users from level', 'qa_db_users_from_level_selectspec', () => [20, 0, 30]],
  ['users from level count', 'qa_db_users_from_level_count_selectspec', () => [20]],
  ['blocked users', 'qa_db_users_with_flag_selectspec', () => [2, 0, 30]],
  ['recent messages', 'qa_db_recent_messages_selectspec', f => [f.from, true, f.to, true, 20]],
  ['wall', 'qa_db_recent_messages_selectspec', f => [null, null, f.wallto, true, 20]],
  ['inbox', 'qa_db_messages_inbox_selectspec', f => ['private', f.to, true, 0, 20]],
  ['wall inbox', 'qa_db_messages_inbox_selectspec', f => ['public', f.wallto, true, 0, 20]],
  ['outbox', 'qa_db_messages_outbox_selectspec', f => ['private', f.from, true, 0, 20]],
  ['is favorite question', 'qa_db_is_favorite_selectspec', f => [f.favuser, 'Q', f.favq]],
  ['is favorite user', 'qa_db_is_favorite_selectspec', f => [f.favuser, 'U', f.handle]],
  ['is favorite tag', 'qa_db_is_favorite_selectspec', f => [f.favuser, 'T', f.tag]],
  ['is favorite category', 'qa_db_is_favorite_selectspec', f => [f.favuser, 'C', f.catbackpath]],
  ['favorite questions', 'qa_db_user_favorite_qs_selectspec', f => [f.favuser, 20]],
  ['favorite users', 'qa_db_user_favorite_users_selectspec', f => [f.favuser, 20]],
  ['favorite tags', 'qa_db_user_favorite_tags_selectspec', f => [f.favuser, 20]],
  ['favorite categories', 'qa_db_user_favorite_categories_selectspec', f => [f.favuser]],
  ['favorite non-questions', 'qa_db_user_favorite_non_qs_selectspec', f => [f.favuser]],
  ['updates', 'qa_db_user_updates_selectspec', f => [f.favuser, true, true]],
  ['updates, favorites only', 'qa_db_user_updates_selectspec', f => [f.favuser, true, false]],
  ['updates, content only', 'qa_db_user_updates_selectspec', f => [f.user, false, true]],
  ['user limits', 'qa_db_user_limits_selectspec', f => [f.user]],
  ['ip limits', 'qa_db_ip_limits_selectspec', f => [f.ip]],
  ['user levels', 'qa_db_user_levels_selectspec', f => [f.handle]],
  ['user levels full', 'qa_db_user_levels_selectspec', f => [f.levelsuser, true, true]],
];

describe('PHP ↔ Node read parity (db/selects.php builders and the shared UI pages)', () => {
  const suffix = randomBytes(3).toString('hex');
  let pool, fixtures, php, node;
  // Everything the fixtures change is put back afterwards: a category on the site, for one, makes
  // Q2A require a category for every new question, which would break the other suites.
  const undo = [];

  beforeAll(async () => {
    pool = createPool();
    const one = async (sql, params = []) => { const [rows] = await pool.query(sql, params); return rows[0] ?? {}; };
    // Something for every builder to find: categories, a page, post meta and favorites of each kind.
    const [parent] = await pool.query("INSERT INTO qa_categories (parentid, title, tags, qcount, position, backpath) VALUES (NULL, ?, ?, 0, 9000, ?)", [`Reads ${suffix}`, `reads-${suffix}`, `reads-${suffix}`]);
    undo.push(() => pool.query('DELETE FROM qa_categories WHERE categoryid=?', [parent.insertId]));
    const [child] = await pool.query("INSERT INTO qa_categories (parentid, title, tags, qcount, position, backpath) VALUES (?, ?, ?, 0, 1, ?)", [parent.insertId, `Child ${suffix}`, `child-${suffix}`, `child-${suffix}/reads-${suffix}`]);
    undo.push(() => pool.query('DELETE FROM qa_categories WHERE categoryid=?', [child.insertId]));
    const busy = await one("SELECT parentid AS q FROM qa_posts WHERE type='A' AND parentid IN (SELECT parentid FROM qa_posts WHERE type='C') GROUP BY parentid ORDER BY COUNT(*) DESC LIMIT 1");
    const q = busy.q ?? (await one("SELECT postid AS q FROM qa_posts WHERE type='Q' ORDER BY postid DESC LIMIT 1")).q;
    const original = await one('SELECT categoryid FROM qa_posts WHERE postid=?', [q]);
    await pool.query('UPDATE qa_posts SET categoryid=? WHERE postid=?', [child.insertId, q]);
    undo.push(() => pool.query('UPDATE qa_posts SET categoryid=? WHERE postid=?', [original.categoryid, q]));
    const meta = await one("SELECT content FROM qa_postmetas WHERE postid=? AND title='qa_q_extra'", [q]);
    undo.push(() => (meta.content === undefined
      ? pool.query("DELETE FROM qa_postmetas WHERE postid=? AND title='qa_q_extra'", [q])
      : pool.query("UPDATE qa_postmetas SET content=? WHERE postid=? AND title='qa_q_extra'", [meta.content, q])));
    await pool.query("INSERT INTO qa_postmetas (postid, title, content) VALUES (?, 'qa_q_extra', ?) ON DUPLICATE KEY UPDATE content=VALUES(content)", [q, `extra ${suffix}`]);
    const author = await one("SELECT p.userid AS user, u.handle FROM qa_posts p JOIN qa_users u ON u.userid=p.userid WHERE p.type IN ('Q','A','C') GROUP BY p.userid ORDER BY COUNT(DISTINCT p.type) DESC, COUNT(*) DESC LIMIT 1");
    const voter = await one('SELECT userid AS voter FROM qa_uservotes ORDER BY postid DESC LIMIT 1');
    const tag = await one('SELECT word AS tag FROM qa_words WHERE tagcount>0 ORDER BY tagcount DESC, word LIMIT 1');
    const words = (await pool.query('SELECT word FROM qa_words WHERE titlecount>0 ORDER BY titlecount DESC, word LIMIT 3'))[0].map(r => r.word);
    const ip = await one("SELECT INET6_NTOA(createip) AS ip FROM qa_posts WHERE createip IS NOT NULL ORDER BY postid DESC LIMIT 1");
    const c = await one("SELECT postid AS c FROM qa_posts WHERE type='C' ORDER BY postid DESC LIMIT 1");
    const closed = await one("SELECT postid AS closedq FROM qa_posts WHERE closedbyid IS NOT NULL ORDER BY postid DESC LIMIT 1");
    const dup = await one("SELECT q.closedbyid AS dupof FROM qa_posts q JOIN qa_posts c ON c.postid=q.closedbyid WHERE c.type='Q' ORDER BY q.postid DESC LIMIT 1");
    const page = await one('SELECT pageid, tags AS pageslug FROM qa_pages ORDER BY pageid DESC LIMIT 1');
    const pm = await one("SELECT fromuserid AS `from`, touserid AS `to` FROM qa_messages WHERE type='PRIVATE' AND fromuserid IS NOT NULL ORDER BY messageid DESC LIMIT 1");
    const wall = await one("SELECT touserid AS wallto FROM qa_messages WHERE type='PUBLIC' ORDER BY messageid DESC LIMIT 1");
    const levels = await one('SELECT userid AS levelsuser FROM qa_userlevels ORDER BY userid DESC LIMIT 1');
    const fav = await one("SELECT userid AS favuser FROM qa_userfavorites WHERE entitytype='Q' ORDER BY userid DESC LIMIT 1");
    const favuser = fav.favuser ?? author.user;
    const favorite = async (type, id) => {
      const [added] = await pool.query('INSERT IGNORE INTO qa_userfavorites (userid, entitytype, entityid, nouserevents) VALUES (?, ?, ?, 0)', [favuser, type, id]);
      if (added.affectedRows) undo.push(() => pool.query('DELETE FROM qa_userfavorites WHERE userid=? AND entitytype=? AND entityid=?', [favuser, type, id]));
    };
    for (const [type, id] of [['C', parent.insertId], ['U', author.user], ['Q', q]]) {
      await favorite(type, id);
    }
    if (tag.tag) {
      const word = await one('SELECT wordid FROM qa_words WHERE word=?', [tag.tag]);
      await favorite('T', word.wordid);
    }
    const postids = (await pool.query('SELECT postid FROM qa_posts WHERE parentid=? OR postid=? ORDER BY postid', [q, q]))[0].map(r => r.postid);
    fixtures = {
      q, c: c.c ?? q, closedq: closed.closedq ?? q, dupof: dup.dupof ?? q, metatitle: 'qa_q_extra',
      user: author.user, handle: author.handle, voter: voter.voter ?? author.user, tag: tag.tag ?? 'none',
      words, tagwords: tag.tag ? [tag.tag] : [], ip: ip.ip ?? '127.0.0.1', postids: [...postids, 999999999],
      parentcat: parent.insertId, childcat: child.insertId, catslugs: [`reads-${suffix}`, `child-${suffix}`], // top-down, as Q2A passes them
      catbackpath: `reads-${suffix}`, pageid: page.pageid ?? 0, pageslug: page.pageslug ?? 'none',
      from: pm.from ?? author.user, to: pm.to ?? author.user, wallto: wall.wallto ?? author.user,
      levelsuser: levels.levelsuser ?? author.user, favuser, favq: q,
    };
    const reads = [...CASES.map(([, name, args, count]) => ({ name, args: args(fixtures), count: !!count })), { name: 'qa_db_time_selectspec', args: [] }];
    [php, node] = await Promise.all([runReads(`${UI_URL}/docker/php/read-harness.php`, reads), runReads(`${API_URL}/api/v1/internal/reads`, reads)]);
  });
  afterAll(async () => {
    for (const step of undo.reverse()) await step();
    await pool.end();
  });

  test.each(CASES.map(([label], index) => [label, index]))('%s', (label, index) => {
    expect(normalise(node[index])).toEqual(normalise(php[index]));
  });

  test('the database time agrees', () => {
    const at = CASES.length;
    expect(node[at].entries.map(([key]) => key)).toEqual(php[at].entries.map(([key]) => key));
    const [[, nodeTime]] = node[at].entries;
    const [[, phpTime]] = php[at].entries;
    expect(Math.abs(Number(nodeTime) - Number(Buffer.from(phpTime.b64, 'base64').toString()))).toBeLessThanOrEqual(2);
  });

  test('fixtures found real rows for the key reads', () => {
    for (const label of ['recent questions', 'child posts', 'popular tags', 'top users', 'category by slugs', 'favorite questions', 'post meta']) {
      const result = php[CASES.findIndex(([name]) => name === label)];
      expect(result.single ? result.value : result.entries.length).toBeTruthy();
    }
  });

  test('internal reads need the bridge key and known builders', async () => {
    const reads = [{ name: 'qa_db_options_selectspec', args: [] }];
    expect((await request(API_URL).post('/api/v1/internal/reads').send({ reads })).status).toBe(404);
    expect((await request(API_URL).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', 'wrong').send({ reads })).status).toBe(404);
    expect((await request(`${UI_URL}/docker/php/read-harness.php`).post('').send({ reads })).status).toBe(404);
    const bad = await request(API_URL).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', KEY).send({ reads: [{ name: 'qa_db_connect', args: [] }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_input');
  });

  test.each([
    '/', '/index.php?qa=questions', '/index.php?qa=questions&sort=hot', '/index.php?qa=unanswered', '/index.php?qa=activity',
    '/index.php?qa=tags', '/index.php?qa=users', '/index.php?qa=categories', '/index.php?qa=search&q=database', '/index.php?qa=admin',
  ])('shared UI page %s renders from Node reads', async path => {
    const res = await request(UI_URL).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['x-q2a-read-backend']).toBe('node-api-v1');
    expect(res.text).toContain('qa-body-wrapper');
    expect(res.text).not.toMatch(/fatal error|Warning:|Notice:/i);
  });

  // Signed-in pages read more (messages, favorites, updates, admin lists) and load more page code.
  test('signed-in user and admin pages render from Node reads', async () => {
    const member = siteDriver('migrated-ui', UI_URL, pool);
    const admin = siteDriver('migrated-ui', UI_URL, pool);
    await member.register(`rdm${suffix}`);
    await admin.register(`rda${suffix}`);
    await pool.query('UPDATE qa_users SET level=120 WHERE handle=?', [`rda${suffix}`]);
    const pages = [
      [member, ['account', 'favorites', 'updates', 'messages', 'messages/sent', `message/${fixtures.handle}`, `user/${fixtures.handle}`, `user/${fixtures.handle}/wall`, `user/${fixtures.handle}/activity`, 'ask', 'feedback', `${fixtures.q}`]],
      [admin, ['admin/general', 'admin/emails', 'admin/users', 'admin/layout', 'admin/posting', 'admin/viewing', 'admin/lists', 'admin/categories', 'admin/permissions', 'admin/pages', 'admin/feeds', 'admin/points', 'admin/spam', 'admin/caching', 'admin/stats', 'admin/mailing', 'admin/plugins', 'admin/moderate', 'admin/flagged', 'admin/hidden', 'admin/approve', 'admin/userfields', 'admin/usertitles', 'admin/layoutwidgets', 'admin/recalc', `ip/${fixtures.ip}`, 'users/special', 'users/blocked']],
    ];
    for (const [driver, paths] of pages) {
      for (const path of paths) {
        const res = await driver._get(`/index.php?qa=${encodeURI(path)}`);
        expect([path, res.status]).toEqual([path, 200]);
        expect([path, res.headers['x-q2a-read-backend']]).toEqual([path, 'node-api-v1']);
        expect([path, /fatal error|Uncaught|Warning<\/b>|Notice<\/b>|Deprecated<\/b>/i.test(res.text)]).toEqual([path, false]);
      }
    }
  });

  test('question, user and tag pages render from Node reads', async () => {
    for (const path of [`/index.php?qa=${fixtures.q}`, `/index.php?qa=user/${encodeURIComponent(fixtures.handle)}`, `/index.php?qa=tag/${encodeURIComponent(fixtures.tag)}`, `/index.php?qa=questions/reads-${suffix}/child-${suffix}`]) {
      const res = await request(UI_URL).get(path).redirects(3);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers['x-q2a-read-backend']).toBe('node-api-v1');
      expect(res.text).not.toMatch(/fatal error|Warning:|Notice:/i);
    }
  });
});
