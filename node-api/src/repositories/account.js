// SQL for account and profile changes, ported from qa-include/db/users.php, db/blobs.php and the
// account selections of db/selects.php. Sessions are the Node API's own (node_auth_sessions).
const { randomBytes } = require('node:crypto');
const { createTransactor, sharedQueries } = require('./shared');

const ACCOUNT_COLUMNS = 'userid, handle, email, level, flags, passhash, passsalt, passcheck, emailcode, avatarwidth, avatarheight';

function createAccountRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    return {
      ...shared,

      // qa_db_user_account_selectspec()
      async findAccount(userid) {
        const [[user]] = await db.execute(`SELECT ${ACCOUNT_COLUMNS}, CAST(avatarblobid AS CHAR) AS avatarblobid FROM qa_users WHERE userid=? FOR UPDATE`, [userid]);
        return user;
      },
      async findAccountByHandle(handle) {
        const [[user]] = await db.execute(`SELECT ${ACCOUNT_COLUMNS}, CAST(avatarblobid AS CHAR) AS avatarblobid FROM qa_users WHERE handle=? LIMIT 1 FOR UPDATE`, [handle]);
        return user;
      },
      // qa_db_user_find_by_handle(), qa_db_user_find_by_email(): matching user IDs (the column collation decides).
      async findUseridsBy(field, value) {
        const [rows] = await db.execute(`SELECT userid FROM qa_users WHERE ${field === 'email' ? 'email' : 'handle'}=?`, [value]);
        return rows.map(row => Number(row.userid));
      },
      async userPostCounts(userid) {
        const [[row]] = await db.execute('SELECT qposts, aposts, cposts FROM qa_userpoints WHERE userid=?', [userid]);
        return row ?? { qposts: 0, aposts: 0, cposts: 0 };
      },
      // qa_db_userfields_selectspec()
      async userFields() {
        const [rows] = await db.query('SELECT fieldid, title FROM qa_userfields ORDER BY position');
        return rows;
      },

      // qa_db_user_set() for one column
      async userSet(userid, column, value) {
        if (!['handle', 'email', 'emailcode', 'sessioncode'].includes(column)) throw new Error(`Unexpected column ${column}`);
        await db.execute(`UPDATE qa_users SET ${column}=? WHERE userid=?`, [value, userid]);
      },
      // qa_db_user_set_flag()
      async userSetFlag(userid, flag, set) {
        await db.execute(`UPDATE qa_users SET flags=flags${set ? '|' : '&~'}? WHERE userid=?`, [flag, userid]);
      },
      // qa_db_user_profile_set()
      async profileSet(userid, title, value) {
        await db.execute('INSERT INTO qa_userprofile (userid, title, content) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)', [userid, title, value]);
      },
      // qa_db_user_set_password() with QA_PASSWORD_HASH
      async setPasswordHash(userid, hash) {
        await db.execute('UPDATE qa_users SET passhash=?, passsalt=NULL, passcheck=NULL WHERE userid=?', [hash, userid]);
      },
      // Clearing sessioncode stops PHP's remembered logins; Node's own sessions end the same way.
      async deleteOtherSessions(userid, keepTokenHash) {
        await db.execute('DELETE FROM node_auth_sessions WHERE userid=? AND token_hash<>?', [userid, keepTokenHash ?? '']);
      },

      // qa_db_blob_create(): a random 64-bit ID, retried if it is taken.
      async blobCreate(content, format, userid, ip) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const blobid = randomBytes(8).readBigUInt64BE().toString();
          const [[exists]] = await db.execute('SELECT COUNT(*) AS n FROM qa_blobs WHERE blobid=?', [blobid]);
          if (Number(exists.n)) continue;
          await db.execute(
            'INSERT INTO qa_blobs (blobid, format, content, filename, userid, cookieid, createip, created) VALUES (?, ?, ?, NULL, ?, NULL, INET6_ATON(?), NOW())',
            [blobid, format, content, userid, ip]);
          return blobid;
        }
        return null;
      },
      // qa_db_user_set() for the avatar columns
      async setAvatar(userid, blobid, width, height) {
        await db.execute('UPDATE qa_users SET avatarblobid=?, avatarwidth=?, avatarheight=? WHERE userid=?', [blobid, width, height, userid]);
      },
      // qa_db_blob_delete()
      async blobDelete(blobid) { await db.execute('DELETE FROM qa_blobs WHERE blobid=?', [blobid]); },
    };
  }
  return { transaction: createTransactor(pool, queries) };
}
module.exports = { createAccountRepository };
