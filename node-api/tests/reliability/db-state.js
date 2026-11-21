// Whole-database comparison and invariant checks for the reliability suites. The PHP site (php-db) and
// the shared UI (node-db) start from the same fresh seed (scripts/fresh-databases.sh), so after the same
// operations every Q2A table should hold the same rows: IDs match because auto-increments line up, and
// what cannot match is normalised: times (masked to "set"), random 64-bit IDs (cookies, blobs: mapped to
// labels by first appearance), password hashes and codes (random by design), hotness (compared within a
// tolerance, since it is built from the creation times), and rate-limit periods and counts (the slice
// suites compare those exactly).
const { createHash } = require('node:crypto');

// Tables Node owns or that only cache derived data.
const SKIP_TABLES = new Set(['node_auth_sessions', 'node_ai_evaluations', 'node_ai_usage', 'qa_cache']);
// Columns that differ by design between two runs of the same operations.
const MASK = {
  qa_users: ['passsalt', 'passcheck', 'passhash', 'sessioncode', 'sessionsource', 'emailcode'],
  qa_userlimits: ['period', 'count'],
  qa_iplimits: ['period', 'count'],
};
// Columns compared not even for being set: PHP's remembered-login columns, which Node's logins leave
// empty because its sessions live in node_auth_sessions (docs/account-migration.md).
const ALWAYS_MASK = { qa_users: ['sessioncode', 'sessionsource'] };
// Columns holding random 64-bit IDs, mapped to labels.
const RANDOM_IDS = {
  qa_cookies: ['cookieid'], qa_posts: ['cookieid'], qa_blobs: ['blobid', 'cookieid'], qa_users: ['avatarblobid'],
  qa_messages: [], qa_uservotes: [],
};
// Tables whose rows are keyed by random IDs: compared as sorted lists once the IDs are labels.
const UNORDERED = new Set(['qa_cookies', 'qa_blobs']);
// Known, documented differences, left out of the comparison and reported instead: Node limits logins and
// registrations in memory rather than in qa_iplimits (docs/auth-migration.md).
const KNOWN_DIFFERENCES = { qa_iplimits: row => ['R', 'L'].includes(row.action), qa_userlimits: row => ['R', 'L'].includes(row.action) };
// Options that hold times or per-installation values rather than site state.
const MASK_OPTIONS = new Set(['mailing_last_timestamp', 'mailing_last_userid', 'db_time', 'form_security_salt']); // the salt is random per installation
const HOTNESS_TOLERANCE = 1e-6; // relative: creation times differ by the seconds between the two runs

async function schema(pool) {
  const [columns] = await pool.query(
    "SELECT TABLE_NAME AS t, COLUMN_NAME AS c, DATA_TYPE AS type, COLUMN_KEY AS k, ORDINAL_POSITION AS pos FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION");
  const tables = new Map();
  for (const { t, c, type, k } of columns) {
    if (SKIP_TABLES.has(t)) continue;
    if (!tables.has(t)) tables.set(t, { columns: [], times: new Set(), primary: [] });
    const table = tables.get(t);
    table.columns.push(c);
    if (['datetime', 'timestamp', 'date', 'time'].includes(type)) table.times.add(c);
    if (k === 'PRI') table.primary.push(c);
  }
  return tables;
}

const hash = buffer => createHash('sha256').update(buffer).digest('hex').slice(0, 16);
function plain(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.length > 64 ? `bytes:${value.length}:${hash(value)}` : `hex:${value.toString('hex')}`;
  return String(value);
}

// Every table as normalised rows, plus the order random IDs were first seen in (for the labels).
async function databaseState(pool) {
  const tables = await schema(pool);
  const labels = new Map();
  const label = (kind, value) => {
    if (value === null || value === undefined || value === '' || value === '0') return value === undefined ? null : plain(value);
    const key = `${kind}:${value}`;
    if (!labels.has(key)) labels.set(key, `${kind}#${[...labels.keys()].filter(k => k.startsWith(`${kind}:`)).length + 1}`);
    return labels.get(key);
  };
  const kindOf = column => (column.includes('blob') ? 'blob' : 'cookie');
  // Deterministic tables first, so references label random IDs in a stable order.
  const order = [...tables.keys()].sort((a, b) => Number(UNORDERED.has(a)) - Number(UNORDERED.has(b)) || a.localeCompare(b));
  const state = {};
  for (const name of order) {
    const table = tables.get(name);
    const orderBy = table.primary.length && !UNORDERED.has(name) ? ` ORDER BY ${table.primary.map(c => `\`${c}\``).join(', ')}` : '';
    // Unordered tables are read in a content order, so unreferenced IDs still get stable labels.
    const contentOrder = UNORDERED.has(name) ? ` ORDER BY ${table.columns.filter(c => !(RANDOM_IDS[name] ?? []).includes(c) && !table.times.has(c)).map(c => `\`${c}\``).join(', ')}` : '';
    const [rows] = await pool.query(`SELECT * FROM \`${name}\`${orderBy || contentOrder}`);
    let normalised = rows.map(row => {
      const out = {};
      for (const column of table.columns) {
        let value = row[column];
        if (table.times.has(column)) value = value === null ? null : 'set';
        else if ((ALWAYS_MASK[name] ?? []).includes(column)) value = 'masked';
        else if ((MASK[name] ?? []).includes(column)) value = value === null ? null : 'masked';
        else if ((RANDOM_IDS[name] ?? []).includes(column)) value = label(kindOf(column), value);
        else if (name === 'qa_options' && column === 'content' && MASK_OPTIONS.has(row.title)) value = 'masked';
        else value = plain(value);
        out[column] = value;
      }
      return out;
    });
    if (!table.primary.length || UNORDERED.has(name)) normalised = normalised.map(r => JSON.stringify(r)).sort().map(r => JSON.parse(r));
    state[name] = normalised;
  }
  return state;
}

// Differences between two database states, at most `limit` per table: [{ table, key, php, node }].
// Q2A stores an option's default the first time a page reads it, so which options have rows depends on
// the pages visited; options are compared where both sides have a row (optionsOnlyOnOneSide lists the rest).
function optionsOnlyOnOneSide(php, node) {
  const titles = rows => new Set(rows.map(r => r.title));
  const [a, b] = [titles(php.qa_options ?? []), titles(node.qa_options ?? [])];
  return { php: [...a].filter(t => !b.has(t)), node: [...b].filter(t => !a.has(t)) };
}
function diffStates(php, node, limit = 5) {
  const differences = [];
  const one = optionsOnlyOnOneSide(php, node);
  const onBoth = rows => rows.filter(r => !one.php.includes(r.title) && !one.node.includes(r.title));
  php = { ...php, qa_options: onBoth(php.qa_options ?? []) };
  node = { ...node, qa_options: onBoth(node.qa_options ?? []) };
  for (const [table, known] of Object.entries(KNOWN_DIFFERENCES)) {
    php = { ...php, [table]: (php[table] ?? []).filter(row => !known(row)) };
    node = { ...node, [table]: (node[table] ?? []).filter(row => !known(row)) };
  }
  for (const table of new Set([...Object.keys(php), ...Object.keys(node)])) {
    const a = php[table] ?? [];
    const b = node[table] ?? [];
    let found = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && found < limit; i++) {
      const x = a[i] ?? null;
      const y = b[i] ?? null;
      if (sameRow(table, x, y)) continue;
      differences.push({ table, row: i, php: x, node: y });
      found++;
    }
    if (a.length !== b.length) differences.push({ table, rows: { php: a.length, node: b.length } });
  }
  return differences;
}
function sameRow(table, x, y) {
  if (x === null || y === null) return x === y;
  for (const column of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (table === 'qa_posts' && column === 'hotness') {
      const [p, n] = [Number(x.hotness), Number(y.hotness)];
      if (Math.abs(p - n) > Math.max(1, Math.abs(p) * HOTNESS_TOLERANCE)) return false;
      continue;
    }
    if (x[column] !== y[column]) return false;
  }
  return true;
}

// Invariants: every cached count and link must agree with the rows it summarises (each query returns
// the violating rows). Definitions follow Q2A's own update and recount functions.
const INVARIANTS = {
  'answer count': "SELECT q.postid, q.acount, COUNT(a.postid) AS actual FROM qa_posts q LEFT JOIN qa_posts a ON a.parentid=q.postid AND a.type='A' WHERE q.type LIKE 'Q%' GROUP BY q.postid HAVING q.acount<>actual",
  'best answer vote': "SELECT q.postid, q.amaxvote, COALESCE(GREATEST(MAX(a.netvotes), 0), 0) AS actual FROM qa_posts q LEFT JOIN qa_posts a ON a.parentid=q.postid AND a.type='A' WHERE q.type LIKE 'Q%' GROUP BY q.postid HAVING q.amaxvote<>actual",
  votes: "SELECT p.postid, p.upvotes, p.downvotes, p.netvotes, SUM(v.vote>0) AS up, SUM(v.vote<0) AS down FROM qa_posts p LEFT JOIN qa_uservotes v ON v.postid=p.postid GROUP BY p.postid HAVING p.upvotes<>COALESCE(up,0) OR p.downvotes<>COALESCE(down,0) OR p.netvotes<>COALESCE(up,0)-COALESCE(down,0)",
  flags: 'SELECT p.postid, p.flagcount, SUM(v.flag>0) AS actual FROM qa_posts p LEFT JOIN qa_uservotes v ON v.postid=p.postid GROUP BY p.postid HAVING p.flagcount<>COALESCE(actual,0)',
  'title word counts': 'SELECT w.wordid, w.word, w.titlecount, COUNT(t.wordid) AS actual FROM qa_words w LEFT JOIN qa_titlewords t ON t.wordid=w.wordid GROUP BY w.wordid HAVING w.titlecount<>actual',
  'content word counts': 'SELECT w.wordid, w.word, w.contentcount, COUNT(c.wordid) AS actual FROM qa_words w LEFT JOIN qa_contentwords c ON c.wordid=w.wordid GROUP BY w.wordid HAVING w.contentcount<>actual',
  'tag word counts': 'SELECT w.wordid, w.word, w.tagwordcount, COUNT(t.wordid) AS actual FROM qa_words w LEFT JOIN qa_tagwords t ON t.wordid=w.wordid GROUP BY w.wordid HAVING w.tagwordcount<>actual',
  'tag counts': 'SELECT w.wordid, w.word, w.tagcount, COUNT(t.wordid) AS actual FROM qa_words w LEFT JOIN qa_posttags t ON t.wordid=w.wordid GROUP BY w.wordid HAVING w.tagcount<>actual',
  'category question counts': "SELECT c.categoryid, c.qcount, GREATEST((SELECT COUNT(*) FROM qa_posts WHERE categoryid=c.categoryid AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath1=c.categoryid AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath2=c.categoryid AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath3=c.categoryid AND type='Q')) AS actual FROM qa_categories c HAVING c.qcount<>actual",
  'site counts': `SELECT o.title, o.content, x.actual FROM qa_options o JOIN (
      SELECT 'cache_qcount' AS title, COUNT(*) AS actual FROM qa_posts WHERE type='Q'
      UNION ALL SELECT 'cache_acount', COUNT(*) FROM qa_posts WHERE type='A'
      UNION ALL SELECT 'cache_ccount', COUNT(*) FROM qa_posts WHERE type='C'
      UNION ALL SELECT 'cache_unaqcount', COUNT(*) FROM qa_posts WHERE type='Q' AND acount=0 AND closedbyid IS NULL
      UNION ALL SELECT 'cache_unselqcount', COUNT(*) FROM qa_posts WHERE type='Q' AND selchildid IS NULL AND closedbyid IS NULL
      UNION ALL SELECT 'cache_unupaqcount', COUNT(*) FROM qa_posts WHERE type='Q' AND amaxvote=0 AND closedbyid IS NULL
      UNION ALL SELECT 'cache_queuedcount', COUNT(*) FROM qa_posts WHERE type IN ('Q_QUEUED','A_QUEUED','C_QUEUED')
      UNION ALL SELECT 'cache_flaggedcount', COUNT(*) FROM qa_posts WHERE flagcount>0 AND type IN ('Q','A','C')
      UNION ALL SELECT 'cache_userpointscount', COUNT(*) FROM qa_userpoints
      UNION ALL SELECT 'cache_tagcount', COUNT(*) FROM qa_words WHERE tagcount>0
    ) x ON x.title=o.title WHERE CAST(o.content AS UNSIGNED)<>x.actual`,
  'selected answer belongs to its question': "SELECT q.postid, q.selchildid FROM qa_posts q LEFT JOIN qa_posts a ON a.postid=q.selchildid WHERE q.selchildid IS NOT NULL AND (a.postid IS NULL OR a.parentid<>q.postid OR a.type NOT LIKE 'A%')",
  'closed by an existing post': 'SELECT q.postid, q.closedbyid FROM qa_posts q LEFT JOIN qa_posts c ON c.postid=q.closedbyid WHERE q.closedbyid IS NOT NULL AND c.postid IS NULL',
  'parents exist': "SELECT p.postid, p.type, p.parentid FROM qa_posts p LEFT JOIN qa_posts parent ON parent.postid=p.parentid WHERE p.parentid IS NOT NULL AND parent.postid IS NULL",
  'answers hang off questions': "SELECT p.postid, p.parentid, parent.type FROM qa_posts p JOIN qa_posts parent ON parent.postid=p.parentid WHERE p.type LIKE 'A%' AND parent.type NOT LIKE 'Q%'",
  'tags only on visible questions': "SELECT t.postid, p.type FROM qa_posttags t LEFT JOIN qa_posts p ON p.postid=t.postid WHERE p.type IS NULL OR p.type<>'Q'",
  'title words only on visible questions': "SELECT t.postid, p.type FROM qa_titlewords t LEFT JOIN qa_posts p ON p.postid=t.postid WHERE p.type IS NULL OR p.type<>'Q'",
  // Closing notes are indexed too (qa_post_index() is called for them).
  'content words only on visible posts': "SELECT c.postid, p.type FROM qa_contentwords c LEFT JOIN qa_posts p ON p.postid=c.postid WHERE p.type IS NULL OR p.type NOT IN ('Q','A','C','NOTE')",
  'favorite questions exist': "SELECT f.userid, f.entityid FROM qa_userfavorites f LEFT JOIN qa_posts p ON p.postid=f.entityid WHERE f.entitytype='Q' AND p.postid IS NULL",
  'votes on existing posts': 'SELECT v.postid, v.userid FROM qa_uservotes v LEFT JOIN qa_posts p ON p.postid=v.postid WHERE p.postid IS NULL',
};

// Counts upstream Q2A itself lets drift by design, which Node copies: qa_flag_set_tohide() adds 1 to
// cache_flaggedcount for every flag, not just a post's first, so a post flagged twice counts twice.
// Left out where only Node is checked (the differential suite compares both sides instead).
function withoutUpstreamDrift(violations) {
  const out = { ...violations };
  if (out['site counts']) {
    out['site counts'] = out['site counts'].filter(row => row.title !== 'cache_flaggedcount');
    if (!out['site counts'].length) delete out['site counts'];
  }
  return out;
}
// { name: [violating rows] } for every invariant with violations.
async function checkInvariants(pool) {
  const violations = {};
  for (const [name, sql] of Object.entries(INVARIANTS)) {
    const [rows] = await pool.query(sql);
    if (rows.length) violations[name] = rows.map(row => JSON.parse(JSON.stringify(row, (k, v) => (typeof v === 'bigint' ? String(v) : v))));
  }
  return violations;
}
// Violations on Node's side that PHP's side does not also have (by invariant and row), i.e. migration bugs.
function onlyInNode(phpViolations, nodeViolations) {
  const extra = {};
  for (const [name, rows] of Object.entries(nodeViolations)) {
    const known = new Set((phpViolations[name] ?? []).map(r => JSON.stringify(r)));
    const mine = rows.filter(r => !known.has(JSON.stringify(r)));
    if (mine.length) extra[name] = mine;
  }
  return extra;
}

// Gives the seed's posts and events the same deterministic times on both sides. Q2A trims event streams
// by time ("updated <= the 6th newest"), so events written in the same second are trimmed together; the two
// seeds ran a second or so apart and may group their events differently. Run on both databases right after
// the reset, before anything else happens.
async function alignSeedTimes(pool) {
  const base = "TIMESTAMP('2026-01-01 00:00:00')";
  await pool.query(`UPDATE qa_posts SET created = ${base} + INTERVAL postid MINUTE, updated = IF(updated IS NULL, NULL, ${base} + INTERVAL postid MINUTE + INTERVAL 30 SECOND)`);
  for (const table of ['qa_sharedevents', 'qa_userevents']) {
    const owner = table === 'qa_userevents' ? 'userid, ' : '';
    await pool.query('SET @n = 0');
    await pool.query(`UPDATE ${table} SET updated = ${base} + INTERVAL (@n := @n + 1) SECOND ORDER BY questionid, lastpostid, ${owner}entitytype, entityid, updatetype, lastuserid`);
  }
  // qa_db_hotness_update() for every question, with the options' weights (default 100 each).
  const [rows] = await pool.query("SELECT title, content FROM qa_options WHERE title LIKE 'hot\\_weight\\_%'");
  const weight = name => Number(rows.find(r => r.title === name)?.content ?? 100);
  await pool.query(
    "UPDATE qa_posts AS x, (SELECT parents.postid, MAX(parents.created) AS qcreated, COALESCE(MAX(children.created), MAX(parents.created)) as acreated, COUNT(children.postid) AS acount, MAX(parents.netvotes) AS netvotes, MAX(parents.views) AS views FROM qa_posts AS parents LEFT JOIN qa_posts AS children ON parents.postid=children.parentid AND children.type='A' WHERE parents.type LIKE 'Q%' GROUP BY postid) AS a SET x.hotness=(" +
    '((TO_DAYS(a.qcreated)-734138)*86400.0+TIME_TO_SEC(a.qcreated))*? + ((TO_DAYS(a.acreated)-734138)*86400.0+TIME_TO_SEC(a.acreated))*? + (a.acount+0.0)*? + (a.netvotes+0.0)*? + (a.views+0.0)*?) WHERE x.postid=a.postid',
    [weight('hot_weight_q_age'), weight('hot_weight_a_age'), weight('hot_weight_answers') * 160000, weight('hot_weight_votes') * 160000, weight('hot_weight_views') * 4000]);
}

// Applies Q2A's event stream trimming to every user stream. Q2A copies a question's event into every
// follower's stream but trims only one follower's, picked at random (qa_db_event_create_for_entity():
// "truncation is just a 'housekeeping' activity"), and Node does the same, so which streams are trimmed
// differs from run to run. Trimming them all, by the same rule as qa_db_user_events_truncate() (at most
// QA_DB_MAX_EVENTS_PER_Q per question, then max_store_user_updates per user, each cut at a time and
// everything at or before it), gives both sides the state that housekeeping heads for. Applied to both
// databases before they are compared.
async function trimEventStreams(pool) {
  const MAX_EVENTS_PER_Q = 5;
  await pool.query(`DELETE e FROM qa_userevents e JOIN (
      SELECT userid, questionid, updated AS cutoff FROM (
        SELECT userid, questionid, updated, ROW_NUMBER() OVER (PARTITION BY userid, questionid ORDER BY updated DESC) AS n FROM qa_userevents
      ) ranked WHERE n = ?
    ) c ON c.userid = e.userid AND c.questionid = e.questionid AND e.updated <= c.cutoff`, [MAX_EVENTS_PER_Q + 1]);
  const [[option]] = await pool.query("SELECT content FROM qa_options WHERE title='max_store_user_updates'");
  const maxStore = Number(option?.content ?? 50);
  await pool.query(`DELETE e FROM qa_userevents e JOIN (
      SELECT userid, updated AS cutoff FROM (
        SELECT userid, updated, ROW_NUMBER() OVER (PARTITION BY userid ORDER BY updated DESC) AS n FROM qa_userevents
      ) ranked WHERE n = ?
    ) c ON c.userid = e.userid AND e.updated <= c.cutoff`, [maxStore + 1]);
}

// Sets options on the given databases and returns a function that puts the old values back (so a suite
// that lifts rate limits leaves the slice suites' defaults in place).
async function setOptions(pools, values) {
  const previous = [];
  for (const pool of pools) {
    for (const [title, content] of Object.entries(values)) {
      const [[row]] = await pool.query('SELECT content FROM qa_options WHERE title=?', [title]);
      previous.push([pool, title, row ? row.content : undefined]);
      await pool.query('INSERT INTO qa_options (title, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [title, content]);
    }
  }
  return async () => {
    for (const [pool, title, content] of previous.reverse()) {
      if (content === undefined) await pool.query('DELETE FROM qa_options WHERE title=?', [title]);
      else await pool.query('UPDATE qa_options SET content=? WHERE title=?', [content, title]);
    }
  };
}

module.exports = { trimEventStreams, setOptions, withoutUpstreamDrift, alignSeedTimes, KNOWN_DIFFERENCES, databaseState, diffStates, optionsOnlyOnOneSide, checkInvariants, onlyInNode, INVARIANTS };
