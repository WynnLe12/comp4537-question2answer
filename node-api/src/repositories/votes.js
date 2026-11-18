// SQL for voting, ported statement-by-statement from qa-include/db/votes.php, db/points.php,
// db/hotness.php, db/post-create.php, db/options.php, db/limits.php and db/users.php.
const { loadOptions } = require('../q2a/options');
const { pointsUpdateStatement } = require('../q2a/points');
const { phpNum } = require('../q2a/php');

function createVoteRepository(pool) {
  // Everything for one vote runs on one connection in one transaction (PHP runs the same
  // statements with autocommit). MySQL user variables in the points SQL are per connection.
  async function transaction(work) {
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
  }

  function queries(db) {
    // qa_db_generic_cache_update(): adjust or recount a cached total stored in qa_options.
    async function cacheUpdate(key, countQuery, increment) {
      let value = increment;
      let sql = 'INSERT INTO qa_options (title, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)';
      if (value === undefined) [[{ value }]] = await db.query(countQuery.replace('COUNT(*)', 'COUNT(*) AS value'));
      else sql += ' + CAST(content AS UNSIGNED)';
      await db.query(sql, [key, value]);
    }

    return {
      loadOptions: () => loadOptions(db),

      // Columns of qa_db_full_post_selectspec() that voting reads.
      async findPost(postid) {
        const [[post]] = await db.execute(
          "SELECT postid, type, LEFT(type, 1) AS basetype, INSTR(type, '_HIDDEN')>0 AS hidden, INSTR(type, '_QUEUED')>0 AS queued, " +
          "userid, parentid, netvotes, CONCAT_WS(',', catidpath1, catidpath2, catidpath3, categoryid) AS categoryids " +
          'FROM qa_posts WHERE postid=? FOR UPDATE', [postid]);
        return post;
      },

      // The logged-in user's cached fields: qa_get_logged_in_user_cache(), points and qa_get_logged_in_levels().
      async findVoter(userid) {
        const [[user]] = await db.execute(
          'SELECT u.userid, u.level, u.flags, COALESCE(p.points, 0) AS points FROM qa_users u LEFT JOIN qa_userpoints p ON p.userid=u.userid WHERE u.userid=?', [userid]);
        if (!user) return null;
        const [levels] = await db.execute("SELECT entityid, level FROM qa_userlevels WHERE userid=? AND entitytype='C'", [userid]);
        return { ...user, categoryLevels: new Map(levels.map(row => [Number(row.entityid), Number(row.level)])) };
      },

      async findLimits(userid, ip, action) {
        const [user] = userid ? await db.execute('SELECT period, count FROM qa_userlimits WHERE userid=? AND action=?', [userid, action]) : [[]];
        const [address] = ip ? await db.execute('SELECT period, count FROM qa_iplimits WHERE ip=INET6_ATON(?) AND action=?', [ip, action]) : [[]];
        return { user: user[0], ip: address[0] };
      },

      async getUserVote(postid, userid) {
        const [[row]] = await db.execute('SELECT vote, flag FROM qa_uservotes WHERE postid=? AND userid=? FOR UPDATE', [postid, userid]);
        return row;
      },

      async setUserVote(postid, userid, vote) {
        await db.execute(
          'INSERT INTO qa_uservotes (postid, userid, vote, flag, votecreated) VALUES (?, ?, ?, 0, NOW()) ON DUPLICATE KEY UPDATE vote=?, voteupdated=NOW()',
          [postid, userid, vote, vote]);
      },

      async recountVotes(postid) {
        await db.execute(
          'UPDATE qa_posts AS x, (SELECT COALESCE(SUM(GREATEST(0,vote)),0) AS upvotes, -COALESCE(SUM(LEAST(0,vote)),0) AS downvotes FROM qa_uservotes WHERE postid=?) AS a ' +
          'SET x.upvotes=a.upvotes, x.downvotes=a.downvotes, x.netvotes=a.upvotes-a.downvotes WHERE x.postid=?', [postid, postid]);
      },

      async findQuestion(postid) {
        const [[row]] = await db.execute('SELECT postid, amaxvote, acount, closedbyid FROM qa_posts WHERE postid=?', [postid]);
        return row;
      },

      // qa_db_amaxvote_update_for_q(): a fixed value, or a full recount when value is undefined.
      // Returns the number of rows actually changed (mysqli affected_rows semantics).
      async setAmaxvote(questionid, value) {
        let newValue = value;
        if (newValue === undefined) {
          [[{ newValue }]] = await db.execute(
            "SELECT COALESCE(GREATEST(MAX(netvotes), 0), 0) AS newValue FROM qa_posts WHERE parentid = ? AND type = 'A'", [questionid]);
        }
        const [result] = await db.execute('UPDATE qa_posts SET amaxvote = ? WHERE postid = ?', [newValue, questionid]);
        return result.changedRows;
      },

      unupaqcountUpdate: increment => cacheUpdate('cache_unupaqcount',
        "SELECT COUNT(*) FROM qa_posts WHERE type = 'Q' AND amaxvote = 0 AND closedbyid IS NULL", increment),

      async updatePoints(userid, columns, options) {
        const statement = pointsUpdateStatement(userid, columns, options);
        if (!statement) return;
        const [result] = await db.query(statement.sql, statement.params);
        if (result.affectedRows === 1) await cacheUpdate('cache_userpointscount', 'SELECT COUNT(*) FROM qa_userpoints', 1);
      },

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

      async userWritten(userid, ip) {
        await db.execute('UPDATE qa_users SET written=NOW(), writeip=INET6_ATON(?) WHERE userid=?', [ip, userid]);
      },

      async postVotes(postid) {
        const [[row]] = await db.execute('SELECT upvotes, downvotes, netvotes FROM qa_posts WHERE postid=?', [postid]);
        return row;
      },
    };
  }

  return { transaction };
}
module.exports = { createVoteRepository };
