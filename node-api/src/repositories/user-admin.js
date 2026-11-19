// SQL for moderating and administering users, ported from qa-include/db/users.php, db/votes.php,
// db/post-update.php, db/points.php and db/admin.php.
const { createTransactor, sharedQueries } = require('./shared');

function createUserAdminRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    const counted = (key, sql) => increment => shared.cacheUpdate(key, sql, increment);
    return {
      ...shared,

      // qa_db_user_account_selectspec() by handle, with the user's points row
      async findAccountByHandle(handle) {
        const [[user]] = await db.execute(
          'SELECT u.userid, u.handle, u.email, u.level, u.flags, CAST(u.avatarblobid AS CHAR) AS avatarblobid, p.points ' +
          'FROM qa_users u LEFT JOIN qa_userpoints p ON p.userid=u.userid WHERE u.handle=? LIMIT 1 FOR UPDATE', [handle]);
        return user;
      },
      // qa_db_user_levels_selectspec(): the user's category-specific levels
      async userLevels(userid) {
        const [rows] = await db.execute('SELECT entitytype, entityid, level FROM qa_userlevels WHERE userid=?', [userid]);
        return rows;
      },
      async findUseridsByEmail(email) {
        const [rows] = await db.execute('SELECT userid FROM qa_users WHERE email=?', [email]);
        return rows.map(row => Number(row.userid));
      },
      async userFields() {
        const [rows] = await db.query('SELECT fieldid, title FROM qa_userfields ORDER BY position');
        return rows;
      },
      async categoryExists(categoryid) {
        const [[row]] = await db.execute('SELECT COUNT(*) AS n FROM qa_categories WHERE categoryid=?', [categoryid]);
        return Number(row.n) > 0;
      },

      async userSetLevel(userid, level) { await db.execute('UPDATE qa_users SET level=? WHERE userid=?', [level, userid]); },
      async userSetEmail(userid, email) { await db.execute('UPDATE qa_users SET email=? WHERE userid=?', [email, userid]); },
      async userSetFlag(userid, flag, set) { await db.execute(`UPDATE qa_users SET flags=flags${set ? '|' : '&~'}? WHERE userid=?`, [flag, userid]); },
      async profileSet(userid, title, value) {
        await db.execute('INSERT INTO qa_userprofile (userid, title, content) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)', [userid, title, value]);
      },
      async clearAvatar(userid) { await db.execute('UPDATE qa_users SET avatarblobid=NULL, avatarwidth=NULL, avatarheight=NULL WHERE userid=?', [userid]); },
      async blobDelete(blobid) { await db.execute('DELETE FROM qa_blobs WHERE blobid=?', [blobid]); },
      // qa_db_user_levels_set()
      async userLevelsSet(userid, levels) {
        await db.execute('DELETE FROM qa_userlevels WHERE userid=?', [userid]);
        for (const { entitytype, entityid, level } of levels) {
          await db.execute('INSERT INTO qa_userlevels (userid, entitytype, entityid, level) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE level = VALUES(level)', [userid, entitytype, entityid, level]);
        }
      },
      // qa_db_uapprovecount_update(); no increment recounts
      uapprovecountUpdate: counted('cache_uapprovecount', 'SELECT COUNT(*) FROM qa_users WHERE level < 10 AND NOT (flags & 2)'),
      userpointscountUpdate: counted('cache_userpointscount', 'SELECT COUNT(*) FROM qa_userpoints'),

      // qa_db_get_user_visible_postids()
      async userVisiblePostids(userid) {
        const [rows] = await db.execute("SELECT postid FROM qa_posts WHERE userid=? AND type IN ('Q', 'A', 'C', 'Q_QUEUED', 'A_QUEUED', 'C_QUEUED')", [userid]);
        return rows.map(row => Number(row.postid));
      },
      // qa_db_uservoteflag_user_get()
      async userVotedFlaggedPostids(userid) {
        const [rows] = await db.execute('SELECT postid FROM qa_uservotes WHERE userid=? AND (vote!=0 OR flag!=0)', [userid]);
        return rows.map(row => Number(row.postid));
      },
      // qa_db_user_delete()
      async userDelete(userid) {
        await db.execute('UPDATE qa_posts SET lastuserid=NULL WHERE lastuserid=?', [userid]);
        await db.execute('DELETE FROM qa_userpoints WHERE userid=?', [userid]);
        await db.execute('DELETE FROM qa_blobs WHERE blobid=(SELECT avatarblobid FROM qa_users WHERE userid=?)', [userid]);
        await db.execute('DELETE FROM qa_users WHERE userid=?', [userid]);
        await db.execute('UPDATE qa_posts SET userid=NULL WHERE userid=?', [userid]);
        await db.execute('DELETE FROM qa_userlogins WHERE userid=?', [userid]);
        await db.execute('DELETE FROM qa_userprofile WHERE userid=?', [userid]);
        await db.execute("DELETE FROM qa_userfavorites WHERE userid=? OR entitytype='U' AND entityid=?", [userid, userid]);
        await db.execute('DELETE FROM qa_userevents WHERE userid=?', [userid]);
        await db.execute('DELETE FROM qa_uservotes WHERE userid=?', [userid]);
        await db.execute('DELETE FROM qa_userlimits WHERE userid=?', [userid]);
        await db.execute('DELETE FROM node_auth_sessions WHERE userid=?', [userid]);
      },
      // qa_db_post_recount_votes(), qa_db_post_recount_flags() without an increment
      async recountVotesAndFlags(postid) {
        await db.execute(
          'UPDATE qa_posts AS x, (SELECT COALESCE(SUM(GREATEST(0,vote)),0) AS upvotes, -COALESCE(SUM(LEAST(0,vote)),0) AS downvotes FROM qa_uservotes WHERE postid=?) AS a SET x.upvotes=a.upvotes, x.downvotes=a.downvotes, x.netvotes=a.upvotes-a.downvotes WHERE x.postid=?',
          [postid, postid]);
        await db.execute(
          'UPDATE qa_posts AS x, (SELECT COALESCE(SUM(IF(flag, 1, 0)), 0) AS flagcount FROM qa_uservotes WHERE postid=?) AS a SET x.flagcount=a.flagcount WHERE x.postid=?',
          [postid, postid]);
      },
      // qa_db_posts_get_userids()
      async postsUserids(postids) {
        if (!postids.length) return [];
        const [rows] = await db.query('SELECT DISTINCT userid FROM qa_posts WHERE postid IN (?) AND userid IS NOT NULL', [postids]);
        return rows.map(row => Number(row.userid));
      },
    };
  }
  return { transaction: createTransactor(pool, queries) };
}
module.exports = { createUserAdminRepository };
