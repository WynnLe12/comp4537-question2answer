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

// Helpers return plain PHP values: arrays (rows, maps, lists) compare as ordered key/value lists, strings
// as bytes, and ints and booleans as themselves.
function canonValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('base64');
  if (Object.keys(value).length === 1 && typeof value.b64 === 'string') return value.b64;
  return { list: Object.entries(value).map(([k, v]) => [String(k), canonValue(v)]) };
}
const canonResult = result => (result.single ? canonValue(result.value) : { list: result.entries.map(([k, v]) => [String(k), canonValue(v)]) });

async function runReads(url, reads) {
  const res = await request(url).post('').set('X-Q2A-Bridge-Key', KEY).send({ reads });
  if (res.status !== 200 || !Array.isArray(res.body?.results)) throw new Error(`${url}: ${res.status} ${res.text.slice(0, 500)}`);
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

// The read helpers in the other db/*.php files (slice 12b): [label, function, args(fixtures)]
const HELPER_CASES = [
  ['user by email', 'qa_db_user_find_by_email', f => [f.email]],
  ['user by email, none', 'qa_db_user_find_by_email', () => ['nobody@example.invalid']],
  ['user by handle', 'qa_db_user_find_by_handle', f => [f.handle]],
  ['handles of users', 'qa_db_user_get_userid_handles', f => [[f.user, f.voter, 999999999]]],
  ['handles of no users', 'qa_db_user_get_userid_handles', () => [[]]],
  ['users of handles', 'qa_db_user_get_handle_userids', f => [[f.handle, 'no-such-handle']]],
  ['external login', 'qa_db_user_login_find', f => ['reads', f.loginid]],
  ['post meta', 'qa_db_meta_get', f => ['postmetas', 'postid', f.q, f.metatitle]],
  ['post meta list', 'qa_db_meta_get', f => ['postmetas', 'postid', f.q, [f.metatitle, 'qa_q_none']]],
  ['user meta, none', 'qa_db_meta_get', f => ['usermetas', 'userid', f.user, 'nothing']],
  ['cookie exists', 'qa_db_cookie_exists', f => [f.cookieid]],
  ['cookie missing', 'qa_db_cookie_exists', () => ['1']],
  ['notices', 'qa_db_usernotices_list', f => [f.user]],
  ['user and ip limits', 'qa_db_limits_get', f => [f.limituser, f.ip, f.limitaction]],
  ['ip limits only', 'qa_db_limits_get', f => [null, f.ip, 'Q']],
  ['no limits asked', 'qa_db_limits_get', () => [null, null, 'Q']],
  ['one vote', 'qa_db_uservote_get', f => [f.votepost, f.voteuser]],
  ['no vote', 'qa_db_uservote_get', f => [f.votepost, 999999999]],
  ['votes on a post', 'qa_db_uservote_post_get', f => [f.votepost]],
  ['posts a user voted or flagged', 'qa_db_uservoteflag_user_get', f => [f.voteuser]],
  ['voters and flaggers', 'qa_db_uservoteflag_posts_get', f => [[f.votepost, ...f.postids]]],
  ['questions among posts', 'qa_db_posts_filter_q_postids', f => [f.postids]],
  ['authors of posts', 'qa_db_posts_get_userids', f => [f.postids]],
  ['tables', 'qa_db_list_tables', () => []],
  ['prefixed tables', 'qa_db_list_tables', () => [true]],
  ['mysql version', 'qa_db_mysql_version', () => []],
  ['table size', 'qa_db_table_size', () => []],
  ['post count', 'qa_db_count_posts', () => []],
  ['question count', 'qa_db_count_posts', () => ['Q']],
  ['anonymous answers', 'qa_db_count_posts', () => ['A', false]],
  ['user comments', 'qa_db_count_posts', () => ['C', true]],
  ['user count', 'qa_db_count_users', () => []],
  ['active posters', 'qa_db_count_active_users', () => ['posts']],
  ['active voters', 'qa_db_count_active_users', () => ['uservotes']],
  ['category count', 'qa_db_count_categories', () => []],
  ['category questions', 'qa_db_count_categoryid_qs', f => [f.childcat]],
  ['uncategorized questions', 'qa_db_count_categoryid_qs', () => [null]],
  ['user visible posts', 'qa_db_get_user_visible_postids', f => [f.user]],
  ['ip visible posts', 'qa_db_get_ip_visible_postids', f => [f.ip]],
  ['dependents', 'qa_db_postids_count_dependents', f => [f.postids]],
  ['unapproved users', 'qa_db_get_unapproved_users', () => [30]],
  ['blobs on disk', 'qa_db_has_blobs_on_disk', () => []],
  ['blobs in db', 'qa_db_has_blobs_in_db', () => []],
  ['last category position', 'qa_db_category_last_pos', f => [f.parentcat]],
  ['last top category position', 'qa_db_category_last_pos', () => [null]],
  ['category depth', 'qa_db_category_child_depth', f => [f.parentcat]],
  ['category parent', 'qa_db_category_get_parent', f => [f.childcat]],
  ['category by slug', 'qa_db_category_slug_to_id', f => [f.parentcat, `child-${f.suffix}`]],
  ['category by slug, none', 'qa_db_category_slug_to_id', () => [null, 'no-such-slug']],
  ['blob', 'qa_db_blob_read', f => [f.blobid]],
  ['blob missing', 'qa_db_blob_read', () => ['1']],
  ['blob exists', 'qa_db_blob_exists', f => [f.blobid]],
  ['cached image', 'qa_db_cache_get', f => ['i_reads', f.cacheid]],
  ['cache miss', 'qa_db_cache_get', () => ['i_reads', '1']],
];

describe('PHP ↔ Node read parity (db/selects.php builders and the shared UI pages)', () => {
  const suffix = randomBytes(3).toString('hex');
  let pool, fixtures, php, node, phpHelpers, nodeHelpers;
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
    // Fixtures for the helpers: a notice, an external login, a cached image, an existing blob and cookie.
    const [notice] = await pool.query("INSERT INTO qa_usernotices (userid, content, format, tags, created) VALUES (?, ?, '', ?, NOW())", [author.user, `Notice ${suffix}`, `tag-${suffix}`]);
    undo.push(() => pool.query('DELETE FROM qa_usernotices WHERE noticeid=?', [notice.insertId]));
    const loginid = `reads-${suffix}`;
    await pool.query("INSERT INTO qa_userlogins (userid, source, identifier, identifiermd5) VALUES (?, 'reads', ?, UNHEX(MD5(?)))", [author.user, loginid, loginid]);
    undo.push(() => pool.query("DELETE FROM qa_userlogins WHERE source='reads' AND identifier=?", [loginid]));
    const cacheid = String(900000000 + parseInt(suffix, 16) % 99999999);
    await pool.query("INSERT INTO qa_cache (type, cacheid, content, created, lastread) VALUES ('i_reads', ?, ?, NOW(), NOW())", [cacheid, Buffer.from([0, 255, 1, 254, 137, 80, 78, 71])]);
    undo.push(() => pool.query("DELETE FROM qa_cache WHERE type='i_reads' AND cacheid=?", [cacheid]));
    const email = await one('SELECT email FROM qa_users WHERE userid=?', [author.user]);
    const blob = await one('SELECT blobid FROM qa_blobs ORDER BY blobid DESC LIMIT 1');
    const cookie = await one('SELECT cookieid FROM qa_cookies ORDER BY created DESC LIMIT 1');
    const limit = await one('SELECT userid, action FROM qa_userlimits ORDER BY period DESC LIMIT 1');
    const vote = await one('SELECT postid, userid FROM qa_uservotes WHERE vote!=0 ORDER BY postid DESC LIMIT 1');
    Object.assign(fixtures, {
      suffix, email: email.email, loginid, cacheid, blobid: blob.blobid ?? '1', cookieid: cookie.cookieid ?? '1',
      limituser: limit.userid ?? author.user, limitaction: limit.action ?? 'Q', votepost: vote.postid ?? q, voteuser: vote.userid ?? fixtures.voter,
    });
    const helperReads = HELPER_CASES.map(([, name, args]) => ({ name, args: args(fixtures) }));
    [phpHelpers, nodeHelpers] = await Promise.all([runReads(`${UI_URL}/docker/php/read-harness.php`, helperReads), runReads(`${API_URL}/api/v1/internal/reads`, helperReads)]);
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

  test.each(HELPER_CASES.map(([label], index) => [label, index]))('helper: %s', (label, index) => {
    expect(canonResult(nodeHelpers[index])).toEqual(canonResult(phpHelpers[index]));
  });

  test('helper fixtures found real rows', () => {
    for (const label of ['user by email', 'external login', 'notices', 'one vote', 'blob', 'cached image', 'cookie exists', 'category parent', 'unapproved users']) {
      const result = phpHelpers[HELPER_CASES.findIndex(([name]) => name === label)];
      expect([label, result.single ? result.value !== null && result.value !== false : result.entries.length > 0]).toEqual([label, true]);
    }
  });

  test('the bridge stores scaled images through Node', async () => {
    const cacheid = String(800000000 + parseInt(suffix, 16) % 99999999);
    const content = Buffer.from([1, 2, 3, 0, 250]).toString('base64');
    const res = await request(API_URL).post('/api/v1/internal/cache').set('X-Q2A-Bridge-Key', KEY).send({ type: 'i_reads', cacheid, content });
    expect(res.status).toBe(204);
    const [[row]] = await pool.query("SELECT content, lastread>=NOW()-INTERVAL 5 SECOND AS fresh FROM qa_cache WHERE type='i_reads' AND cacheid=?", [cacheid]);
    expect([row.content.toString('base64'), Number(row.fresh)]).toEqual([content, 1]);
    await pool.query("DELETE FROM qa_cache WHERE type='i_reads' AND cacheid=?", [cacheid]);
    expect((await request(API_URL).post('/api/v1/internal/cache').send({ type: 'i_reads', cacheid, content })).status).toBe(404);
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
