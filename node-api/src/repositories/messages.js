// SQL for private messages and wall posts, ported from qa-include/db/messages.php and the message
// selections of db/selects.php that the pages use to decide which messages can be deleted.
const { createTransactor, sharedQueries } = require('./shared');

const RETRIEVE_MESSAGES = 20; // QA_DB_RETRIEVE_MESSAGES

function createMessageRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    return {
      ...shared,

      // qa_db_user_account_selectspec() by handle: the fields the message and wall pages check.
      async findUserByHandle(handle) {
        const [[user]] = await db.execute('SELECT userid, handle, flags FROM qa_users WHERE handle=? LIMIT 1', [handle]);
        return user;
      },
      // qa_db_message_create()
      async messageCreate(fromuserid, touserid, content, format, isPublic) {
        const [result] = await db.execute(
          'INSERT INTO qa_messages (type, fromuserid, touserid, content, format, created) VALUES (?, ?, ?, ?, ?, NOW())',
          [isPublic ? 'PUBLIC' : 'PRIVATE', fromuserid, touserid, content, format]);
        return result.insertId;
      },
      // qa_db_user_recount_posts()
      async userRecountPosts(userid) {
        await db.execute(
          "UPDATE qa_users AS x, (SELECT COUNT(*) AS wallposts FROM qa_messages WHERE touserid=? AND type='PUBLIC') AS a SET x.wallposts=a.wallposts WHERE x.userid=?",
          [userid, userid]);
      },
      // qa_db_message_delete()
      async messageDelete(messageid, isPublic = true) {
        await db.execute(`DELETE FROM qa_messages WHERE messageid=?${isPublic ? '' : ' AND fromhidden=1 AND tohidden=1'}`, [messageid]);
      },
      // qa_db_message_user_hide()
      async messageUserHide(messageid, box) {
        await db.execute(`UPDATE qa_messages SET ${box === 'inbox' ? 'tohidden' : 'fromhidden'}=1 WHERE messageid=?`, [messageid]);
      },
      async findMessage(messageid) {
        const [[message]] = await db.execute('SELECT messageid, type, fromuserid, touserid, fromhidden, tohidden FROM qa_messages WHERE messageid=? FOR UPDATE', [messageid]);
        return message;
      },
      // qa_db_recent_messages_selectspec(null, null, touserid, true, page_size_wall): the first page of a wall.
      async recentWallPosts(touserid, count) {
        const [rows] = await db.query(
          "SELECT messageid, fromuserid, touserid FROM qa_messages WHERE type='PUBLIC' AND touserid=? ORDER BY qa_messages.created DESC LIMIT ?, ?",
          [touserid, 0, Math.min(count, RETRIEVE_MESSAGES)]);
        return rows;
      },
    };
  }
  return { transaction: createTransactor(pool, queries) };
}
module.exports = { createMessageRepository };
