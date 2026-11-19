// SQL for favorites, ported statement-by-statement from qa-include/db/favorites.php,
// db/events.php (qa_db_user_events_truncate) and db/options.php.
const { createTransactor, sharedQueries } = require('./shared');
const { phpInt } = require('../q2a/php');

const MAX_EVENTS_PER_Q = 5; // QA_DB_MAX_EVENTS_PER_Q

function createFavoriteRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    const one = async (sql, params) => Object.values((await db.query(sql, params))[0][0] ?? {})[0] ?? null;

    // qa_db_user_events_truncate() without a question ID: trims the stream to its overall length.
    async function userEventsTruncate(userid, maxStoreUserUpdates) {
      const truncate = await one('SELECT updated FROM qa_userevents WHERE userid=? ORDER BY updated DESC LIMIT ?,1', [userid, phpInt(maxStoreUserUpdates)]);
      if (truncate !== null) await db.query('DELETE FROM qa_userevents WHERE userid=? AND updated<=?', [userid, truncate]);
    }

    return {
      ...shared,

      // qa_db_favorite_create()
      async favoriteCreate(userid, entitytype, entityid, options) {
        let threshold = options.get('max_copy_user_updates');
        // qa_opt() stores the default the first time it reads an option that has no row.
        if (!options.isStored('max_copy_user_updates')) {
          await db.query('INSERT IGNORE INTO qa_options (title, content) VALUES (?, ?)', ['max_copy_user_updates', String(threshold)]);
        }
        await db.query('INSERT IGNORE INTO qa_userfavorites (userid, entitytype, entityid, nouserevents) VALUES (?, ?, ?, 0)', [userid, entitytype, entityid]);
        let useshared = Number(await one('SELECT COUNT(*) FROM qa_userfavorites WHERE entitytype=? AND entityid=? AND nouserevents>0 LIMIT 1', [entitytype, entityid])) > 0;
        if (!useshared) {
          const favoriters = Number(await one('SELECT COUNT(*) FROM qa_userfavorites WHERE entitytype=? AND entityid=? LIMIT ?', [entitytype, entityid, phpInt(threshold)]));
          useshared = favoriters >= Number(threshold);
        }
        if (useshared) {
          const maxshared = Number(await one(
            'SELECT MAX(c) FROM (SELECT COUNT(*) AS c FROM qa_userfavorites AS shared JOIN qa_userfavorites AS unshared ' +
            'WHERE shared.userid=unshared.userid AND shared.nouserevents>0 AND unshared.entitytype=? AND unshared.entityid=? AND unshared.nouserevents=0 GROUP BY shared.userid) y',
            [entitytype, entityid]));
          if (maxshared + 1 > Number(threshold)) {
            threshold = String(maxshared + 1);
            await db.query('INSERT INTO qa_options (title, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content=VALUES(content)', ['max_copy_user_updates', threshold]);
          }
          await db.query('UPDATE qa_userfavorites SET nouserevents=1 WHERE entitytype=? AND entityid=? AND nouserevents=0', [entitytype, entityid]);
        } else {
          await db.query(
            'INSERT INTO qa_userevents (userid, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated) ' +
            'SELECT ?, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated FROM qa_sharedevents WHERE entitytype=? AND entityid=?',
            [userid, entitytype, entityid]);
          await userEventsTruncate(userid, options.get('max_store_user_updates'));
        }
      },

      // qa_db_favorite_delete()
      async favoriteDelete(userid, entitytype, entityid) {
        await db.query('DELETE FROM qa_userfavorites WHERE userid=? AND entitytype=? AND entityid=?', [userid, entitytype, entityid]);
        await db.query('DELETE FROM qa_userevents WHERE userid=? AND entitytype=? AND entityid=?', [userid, entitytype, entityid]);
      },
    };
  }

  return { transaction: createTransactor(pool, queries), MAX_EVENTS_PER_Q };
}
module.exports = { createFavoriteRepository };
