// SQL steps shared by several migrated features, each ported from the Q2A function named above it.
// Every function takes the connection of the current transaction.
const { loadOptions } = require('../q2a/options');
const { pointsUpdateStatement } = require('../q2a/points');
const { phpNum } = require('../q2a/php');

// One connection and one transaction per operation (PHP runs the same statements with autocommit).
// MySQL user variables in the points SQL are per connection.
function createTransactor(pool, queries) {
  return async function transaction(work) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(queries(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };
}

function sharedQueries(db) {
  // qa_db_generic_cache_update(): adjust (increment) or recount (increment undefined) a total in qa_options.
  async function cacheUpdate(key, countQuery, increment) {
    let value = increment;
    let sql = 'INSERT INTO qa_options (title, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)';
    if (value === undefined) [[{ value }]] = await db.query(countQuery.replace('COUNT(*)', 'COUNT(*) AS value'));
    else sql += ' + CAST(content AS UNSIGNED)';
    await db.query(sql, [key, value]);
  }

  return {
    cacheUpdate,
    loadOptions: () => loadOptions(db),

    // The logged-in user's cached fields: qa_get_logged_in_user_cache(), points and qa_get_logged_in_levels().
    async findActor(userid) {
      const [[user]] = await db.execute(
        'SELECT u.userid, u.handle, u.level, u.flags, COALESCE(p.points, 0) AS points FROM qa_users u LEFT JOIN qa_userpoints p ON p.userid=u.userid WHERE u.userid=?', [userid]);
      if (!user) return null;
      const [levels] = await db.execute("SELECT entityid, level FROM qa_userlevels WHERE userid=? AND entitytype='C'", [userid]);
      return { ...user, categoryLevels: new Map(levels.map(row => [Number(row.entityid), Number(row.level)])) };
    },

    async findLimits(userid, ip, action) {
      const [user] = userid ? await db.execute('SELECT period, count FROM qa_userlimits WHERE userid=? AND action=?', [userid, action]) : [[]];
      const [address] = ip ? await db.execute('SELECT period, count FROM qa_iplimits WHERE ip=INET6_ATON(?) AND action=?', [ip, action]) : [[]];
      return { user: user[0], ip: address[0] };
    },

    // qa_db_points_update_ifuser(); a new qa_userpoints row also bumps cache_userpointscount.
    async updatePoints(userid, columns, options) {
      const statement = pointsUpdateStatement(userid, columns, options);
      if (!statement) return;
      const [result] = await db.query(statement.sql, statement.params);
      if (result.affectedRows === 1) await cacheUpdate('cache_userpointscount', 'SELECT COUNT(*) FROM qa_userpoints', 1);
    },

    // qa_db_hotness_update() for one question.
    async updateHotness(postid, options) {
      const o = name => phpNum(options.get(name));
      await db.query(
        "UPDATE qa_posts AS x, (SELECT parents.postid, MAX(parents.created) AS qcreated, COALESCE(MAX(children.created), MAX(parents.created)) as acreated, COUNT(children.postid) AS acount, MAX(parents.netvotes) AS netvotes, MAX(parents.views) AS views FROM qa_posts AS parents LEFT JOIN qa_posts AS children ON parents.postid=children.parentid AND children.type='A' WHERE parents.postid BETWEEN ? AND ? GROUP BY postid) AS a SET x.hotness=(" +
        '((TO_DAYS(a.qcreated)-734138)*86400.0+TIME_TO_SEC(a.qcreated))*? + ' +
        '((TO_DAYS(a.acreated)-734138)*86400.0+TIME_TO_SEC(a.acreated))*? + ' +
        '(a.acount+0.0)*? + (a.netvotes+0.0)*? + (a.views+0.0)*?) WHERE x.postid=a.postid',
        [postid, postid, o('hot_weight_q_age'), o('hot_weight_a_age'), o('hot_weight_answers') * 160000, o('hot_weight_votes') * 160000, o('hot_weight_views') * 4000]);
    },

    // qa_limits_increment(): period is hours since the epoch by database time.
    async incrementLimits(userid, ip, action, period) {
      const upsert = 'ON DUPLICATE KEY UPDATE count=IF(period=?, count+?, ?), period=?';
      if (userid) {
        await db.execute(`INSERT INTO qa_userlimits (userid, action, period, count) VALUES (?, ?, ?, ?) ${upsert}`, [userid, action, period, 1, period, 1, 1, period]);
      }
      await db.execute(`INSERT INTO qa_iplimits (ip, action, period, count) VALUES (INET6_ATON(?), ?, ?, ?) ${upsert}`, [ip, action, period, 1, period, 1, 1, period]);
    },

    // qa_user_report_action() / qa_cookie_report_action(): record the last write and its address.
    async userWritten(userid, ip) {
      await db.execute('UPDATE qa_users SET written=NOW(), writeip=INET6_ATON(?) WHERE userid=?', [ip, userid]);
    },
    async cookieWritten(cookieid, ip) {
      await db.execute('UPDATE qa_cookies SET written=NOW(), writeip=INET6_ATON(?) WHERE cookieid=?', [ip, cookieid]);
    },
  };
}

module.exports = { createTransactor, sharedQueries };
