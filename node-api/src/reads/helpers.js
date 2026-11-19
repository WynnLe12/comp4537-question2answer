// Ports of the read helpers in qa-include/db/*.php that pages call outside db/selects.php. Each runs
// PHP's SQL through qa_db_apply_sub()'s rules and returns what the PHP function returns, in the
// internal reads' result shape: { single: true, value } or { single: false, entries: [[key, value]] }.
const { applySub } = require('./execute');
const { ipHex } = require('./selects');

const BINARY_CHARSET = 63;
const STRING_TYPES = new Set([15, 253, 254, 249, 250, 251, 252]);
const QA_CATEGORY_DEPTH = 4;
const QA_USER_LEVEL_APPROVED = 10;
const QA_USER_FLAGS_USER_BLOCKED = 2;

// Rows as mysqli gives them: text, or { b64 } for binary columns.
async function rowsOf(db, query, args = []) {
  const { sql } = applySub(query, args);
  const [rows, fields] = await db.query({ sql, typeCast: field => field.buffer() });
  const binary = new Set(fields.filter(f => f.characterSet === BINARY_CHARSET && STRING_TYPES.has(f.columnType)).map(f => f.name));
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => [name,
    value === null ? null : binary.has(name) ? { b64: value.toString('base64') } : value.toString('utf8')])));
}
const keyText = key => (key && typeof key === 'object' ? key.b64 : String(key));

// qa_db_read_all_values()
const allValues = rows => ({ single: false, entries: rows.map((row, index) => [index, Object.values(row)[0]]) });
// qa_db_read_all_assoc($result, $key, $value): a repeated key keeps its first position and last row.
function allAssoc(rows, key = null, value = null) {
  const map = new Map();
  rows.forEach((row, index) => {
    const k = key === null ? index : row[key];
    map.set(key === null ? index : keyText(k), [k, value === null ? row : row[value]]);
  });
  return { single: false, entries: [...map.values()] };
}
// qa_db_read_one_value() / qa_db_read_one_assoc(): with $allowempty, nothing is null; without, PHP stops.
function oneValue(rows, allowempty = false) {
  if (!rows.length && !allowempty) throw new Error('Reading one value from empty results');
  return { single: true, value: rows.length ? Object.values(rows[0])[0] : null };
}
function oneAssoc(rows, allowempty = false) {
  if (!rows.length && !allowempty) throw new Error('Reading one assoc from empty results');
  return { single: true, value: rows[0] ?? null };
}
const scalar = value => ({ single: true, value });
const isset = value => value !== null && value !== undefined;
// PHP truthiness: '0', '', 0, false, null and empty arrays are false (JavaScript counts '0' as true).
const truthy = value => (Array.isArray(value) ? value.length > 0 : Boolean(value) && value !== '0');
const list = value => (Array.isArray(value) ? value : Object.values(value ?? {}));

// The meta tables qa_db_meta_get() is called for (db/metas.php), with their ID columns.
const META_TABLES = { postmetas: 'postid', usermetas: 'userid', categorymetas: 'categoryid', tagmetas: 'tag' };

const helpers = {
  // db/users.php
  async qa_db_user_find_by_email(db, email) { return allValues(await rowsOf(db, 'SELECT userid FROM ^users WHERE email=$', [email])); },
  async qa_db_user_find_by_handle(db, handle) { return allValues(await rowsOf(db, 'SELECT userid FROM ^users WHERE handle=$', [handle])); },
  async qa_db_user_get_userid_handles(db, userids) {
    const ids = list(userids);
    return ids.length ? allAssoc(await rowsOf(db, 'SELECT userid, handle FROM ^users WHERE userid IN (#)', [ids]), 'userid', 'handle') : { single: false, entries: [] };
  },
  async qa_db_user_get_handle_userids(db, handles) {
    const names = list(handles);
    return names.length ? allAssoc(await rowsOf(db, 'SELECT handle, userid FROM ^users WHERE handle IN ($)', [names]), 'handle', 'userid') : { single: false, entries: [] };
  },
  async qa_db_user_login_find(db, source, identifier) {
    const md5 = require('node:crypto').createHash('md5').update(String(identifier ?? '')).digest('hex');
    return allAssoc(await rowsOf(db, 'SELECT ^userlogins.userid, handle, email FROM ^userlogins LEFT JOIN ^users ON ^userlogins.userid=^users.userid WHERE source=$ AND identifiermd5=UNHEX($) AND identifier=$', [source, md5, identifier]));
  },
  // db/metas.php
  async qa_db_meta_get(db, metatable, idcolumn, idvalue, title) {
    if (META_TABLES[metatable] !== idcolumn) throw Object.assign(new Error('unknown meta table'), { status: 400, code: 'invalid_input' });
    if (Array.isArray(title) || (title && typeof title === 'object')) {
      const titles = list(title);
      return titles.length ? allAssoc(await rowsOf(db, `SELECT title, content FROM ^${metatable} WHERE ${idcolumn}=$ AND title IN($)`, [idvalue, titles]), 'title', 'content') : { single: false, entries: [] };
    }
    return oneValue(await rowsOf(db, `SELECT content FROM ^${metatable} WHERE ${idcolumn}=$ AND title=$`, [idvalue, title]), true);
  },
  // db/cookies.php, db/notices.php
  async qa_db_cookie_exists(db, cookieid) { return scalar(Number(oneValue(await rowsOf(db, 'SELECT COUNT(*) FROM ^cookies WHERE cookieid=#', [cookieid])).value) > 0); },
  async qa_db_usernotices_list(db, userid) { return allAssoc(await rowsOf(db, 'SELECT noticeid, tags, UNIX_TIMESTAMP(created) AS created FROM ^usernotices WHERE userid=$ ORDER BY created', [userid])); },
  // db/limits.php
  async qa_db_limits_get(db, userid, ip, action) {
    const selects = [];
    const args = [];
    if (isset(userid)) { selects.push("(SELECT 'user' AS limitkey, period, count FROM ^userlimits WHERE userid=$ AND action=$)"); args.push(userid, action); }
    if (isset(ip)) { selects.push("(SELECT 'ip' AS limitkey, period, count FROM ^iplimits WHERE ip=UNHEX($) AND action=$)"); args.push(ipHex(ip), action); }
    return selects.length ? allAssoc(await rowsOf(db, selects.join(' UNION ALL '), args), 'limitkey') : { single: false, entries: [] };
  },
  // db/votes.php
  async qa_db_uservote_get(db, postid, userid) { return oneAssoc(await rowsOf(db, 'SELECT postid, userid, vote, flag, votecreated, voteupdated FROM ^uservotes WHERE postid=# AND userid=#', [postid, userid]), true); },
  async qa_db_uservote_post_get(db, postid) { return allAssoc(await rowsOf(db, 'SELECT userid, vote FROM ^uservotes WHERE postid=# AND vote!=0', [postid]), 'userid', 'vote'); },
  async qa_db_uservoteflag_user_get(db, userid) { return allValues(await rowsOf(db, 'SELECT postid FROM ^uservotes WHERE userid=# AND (vote!=0 OR flag!=0)', [userid])); },
  async qa_db_uservoteflag_posts_get(db, postids) {
    return allAssoc(await rowsOf(db, 'SELECT postid, handle, vote, flag, votecreated, voteupdated FROM ^uservotes LEFT JOIN ^users ON ^uservotes.userid=^users.userid WHERE postid IN (#) AND (vote!=0 OR flag!=0)', [list(postids)]));
  },
  // db/blobs.php
  async qa_db_blob_read(db, blobid) { return oneAssoc(await rowsOf(db, 'SELECT content, format, filename FROM ^blobs WHERE blobid=#', [blobid]), true); },
  async qa_db_blob_exists(db, blobid) { return scalar(Number(oneValue(await rowsOf(db, 'SELECT COUNT(*) FROM ^blobs WHERE blobid=#', [blobid])).value) > 0); },
  // qa-db.php
  async qa_db_list_tables(db, onlyTablesWithPrefix = false) {
    let query = 'SHOW TABLES';
    if (truthy(onlyTablesWithPrefix)) query += ` WHERE \`Tables_in_${process.env.DB_NAME || 'q2a'}\` LIKE "qa\\_%"`;
    return allValues(await rowsOf(db, query));
  },
  // db/post-update.php
  async qa_db_posts_filter_q_postids(db, postids) {
    const ids = list(postids);
    return ids.length ? allValues(await rowsOf(db, "SELECT postid FROM ^posts WHERE type='Q' AND postid IN (#)", [ids])) : { single: false, entries: [] };
  },
  async qa_db_posts_get_userids(db, postids) {
    const ids = list(postids);
    return ids.length ? allValues(await rowsOf(db, 'SELECT DISTINCT userid FROM ^posts WHERE postid IN (#) AND userid IS NOT NULL', [ids])) : { single: false, entries: [] };
  },
  // db/cache.php: a cache hit also records when it was last read, as PHP does.
  async qa_db_cache_get(db, type, cacheid) {
    const found = oneValue(await rowsOf(db, 'SELECT content FROM ^cache WHERE type=$ AND cacheid=#', [type, cacheid]), true);
    if (found.value !== null) {
      await db.query({ sql: applySub('UPDATE ^cache SET lastread=NOW() WHERE type=$ AND cacheid=#', [type, cacheid]).sql });
    }
    return found;
  },
  // db/admin.php
  async qa_db_mysql_version(db) { return oneValue(await rowsOf(db, 'SELECT VERSION()')); },
  async qa_db_table_size(db) {
    let size = 0;
    for (const status of await rowsOf(db, "SHOW TABLE STATUS LIKE 'qa_%'")) size += Number(status.Data_length ?? 0) + Number(status.Index_length ?? 0);
    return scalar(size);
  },
  async qa_db_count_posts(db, type = null, fromuser = null) {
    let where = '';
    const args = [];
    if (isset(type)) { where += ' WHERE type=$'; args.push(type); }
    if (isset(fromuser)) where += `${where.length ? ' AND' : ' WHERE'} userid ${truthy(fromuser) ? 'IS NOT' : 'IS'} NULL`;
    return oneValue(await rowsOf(db, `SELECT COUNT(*) FROM ^posts${where}`, args));
  },
  async qa_db_count_users(db) { return oneValue(await rowsOf(db, 'SELECT COUNT(*) FROM ^users')); },
  async qa_db_count_active_users(db, table) {
    if (!['posts', 'uservotes', 'userpoints'].includes(table)) throw new Error('qa_db_count_active_users() called for unknown table');
    return oneValue(await rowsOf(db, `SELECT COUNT(DISTINCT(userid)) FROM ^${table}`));
  },
  async qa_db_count_categories(db) { return oneValue(await rowsOf(db, 'SELECT COUNT(*) FROM ^categories')); },
  async qa_db_count_categoryid_qs(db, categoryid) { return oneValue(await rowsOf(db, "SELECT COUNT(*) FROM ^posts WHERE categoryid<=># AND type='Q'", [categoryid])); },
  async qa_db_get_user_visible_postids(db, userid) { return allValues(await rowsOf(db, "SELECT postid FROM ^posts WHERE userid=# AND type IN ('Q', 'A', 'C', 'Q_QUEUED', 'A_QUEUED', 'C_QUEUED')", [userid])); },
  async qa_db_get_ip_visible_postids(db, ip) { return allValues(await rowsOf(db, "SELECT postid FROM ^posts WHERE createip=UNHEX($) AND type IN ('Q', 'A', 'C', 'Q_QUEUED', 'A_QUEUED', 'C_QUEUED')", [ipHex(ip)])); },
  async qa_db_postids_count_dependents(db, postids) {
    const ids = list(postids);
    if (!ids.length) return { single: false, entries: [] };
    return allAssoc(await rowsOf(db, "SELECT postid, COALESCE(childcount, 0) AS count FROM ^posts LEFT JOIN (SELECT parentid, COUNT(*) AS childcount FROM ^posts WHERE parentid IN (#) AND LEFT(type, 1) IN ('A', 'C') GROUP BY parentid) x ON postid=x.parentid WHERE postid IN (#)", [ids, ids]), 'postid', 'count');
  },
  async qa_db_get_unapproved_users(db, count) {
    const rows = await rowsOf(db, 'SELECT ^users.userid, UNIX_TIMESTAMP(created) AS created, createip, email, handle, flags, title, content FROM ^users LEFT JOIN ^userprofile ON ^users.userid=^userprofile.userid AND LENGTH(content)>0 WHERE level<# AND NOT (flags&#) ORDER BY created DESC LIMIT #', [QA_USER_LEVEL_APPROVED, QA_USER_FLAGS_USER_BLOCKED, count]);
    const users = new Map();
    for (const row of rows) {
      if (!users.has(row.userid)) {
        const { title, content, ...user } = row;
        users.set(row.userid, { ...user, profile: {} });
      }
      if (isset(row.title) && isset(row.content)) users.get(row.userid).profile[row.title] = row.content;
    }
    return { single: false, entries: [...users.entries()] };
  },
  async qa_db_has_blobs_on_disk(db) { return scalar(oneValue(await rowsOf(db, 'SELECT blobid FROM ^blobs WHERE content IS NULL LIMIT 1'), true).value !== null); },
  async qa_db_has_blobs_in_db(db) { return scalar(oneValue(await rowsOf(db, 'SELECT blobid FROM ^blobs WHERE content IS NOT NULL LIMIT 1'), true).value !== null); },
  async qa_db_category_last_pos(db, parentid) { return oneValue(await rowsOf(db, 'SELECT COALESCE(MAX(position), 0) FROM ^categories WHERE parentid<=>#', [parentid])); },
  async qa_db_category_child_depth(db, categoryid) {
    const [result] = await rowsOf(db, 'SELECT COUNT(child1.categoryid) AS count1, COUNT(child2.categoryid) AS count2, COUNT(child3.categoryid) AS count3 FROM ^categories AS child1 LEFT JOIN ^categories AS child2 ON child2.parentid=child1.categoryid LEFT JOIN ^categories AS child3 ON child3.parentid=child2.categoryid WHERE child1.parentid=#;', [categoryid]);
    for (let depth = QA_CATEGORY_DEPTH - 1; depth >= 1; depth--) if (Number(result[`count${depth}`])) return scalar(depth);
    return scalar(0);
  },
  async qa_db_category_get_parent(db, categoryid) { return oneValue(await rowsOf(db, 'SELECT parentid FROM ^categories WHERE categoryid=#', [categoryid])); },
  async qa_db_category_slug_to_id(db, parentid, slug) { return oneValue(await rowsOf(db, 'SELECT categoryid FROM ^categories WHERE parentid<=># AND tags=$', [parentid, slug]), true); },
};

// qa_db_cache_set(): drop entries unread for a day, then store this one.
const QA_DB_MAX_CACHE_AGE = 86400;
async function cacheSet(db, type, cacheid, content) {
  await db.query({ sql: applySub('DELETE FROM ^cache WHERE lastread<NOW()-INTERVAL # SECOND', [QA_DB_MAX_CACHE_AGE]).sql });
  // The content is binary, so it goes as a parameter; the rest as qa_db_apply_sub() writes it.
  await db.query('INSERT INTO qa_cache (type, cacheid, content, created, lastread) VALUES (?, ?, ?, NOW(), NOW()) ON DUPLICATE KEY UPDATE content = VALUES(content), created = VALUES(created), lastread = VALUES(lastread)', [type, String(cacheid), content]);
}

module.exports = { helpers, cacheSet };
