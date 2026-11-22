// SQL for creating and changing questions, answers and comments, ported statement-by-statement from
// qa-include/db/post-create.php, db/post-update.php, db/votes.php, db/events.php, db/cookies.php and db/selects.php.
const { randomBytes } = require('node:crypto');
const { createTransactor, sharedQueries } = require('./shared');
const { phpInt } = require('../q2a/php');

const MAX_EVENTS_PER_Q = 5; // QA_DB_MAX_EVENTS_PER_Q
const MAX_WORD_COUNT = 255; // QA_DB_MAX_WORD_COUNT
const POST_COLUMNS = "postid, type, LEFT(type, 1) AS basetype, INSTR(type, '_HIDDEN')>0 AS hidden, INSTR(type, '_QUEUED')>0 AS queued, " +
  'userid, CAST(cookieid AS CHAR) AS cookieid, parentid, categoryid, acount, amaxvote, netvotes, closedbyid, selchildid, lastuserid, flagcount, ' +
  'title, content, format, tags, notify, name, updated, created, ' +
  "CONCAT_WS(',', catidpath1, catidpath2, catidpath3, categoryid) AS categoryids";

function createPostRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    let maxStoreUserUpdates = 50; // max_store_user_updates, set from the loaded options
    const counted = (key, sql) => increment => shared.cacheUpdate(key, sql, increment);

    // qa_db_word_mapto_ids(): keyed by the word as stored (the column's collation decides matches).
    async function wordMapToIds(words) {
      if (!words.length) return new Map();
      const [rows] = await db.query('SELECT wordid, word FROM qa_words WHERE word IN (?)', [words]);
      return new Map(rows.map(row => [row.word, row.wordid]));
    }

    async function userEventsTruncate(userid, questionid) {
      let truncated = false;
      if (questionid !== null && questionid !== undefined) {
        const [[row]] = await db.query('SELECT updated FROM qa_userevents WHERE userid=? AND questionid=? ORDER BY updated DESC LIMIT ?,1', [userid, questionid, MAX_EVENTS_PER_Q]);
        if (row) {
          await db.query('DELETE FROM qa_userevents WHERE userid=? AND questionid=? AND updated<=?', [userid, questionid, row.updated]);
          truncated = true;
        }
      }
      if (!truncated) {
        const [[row]] = await db.query('SELECT updated FROM qa_userevents WHERE userid=? ORDER BY updated DESC LIMIT ?,1', [userid, maxStoreUserUpdates]);
        if (row) await db.query('DELETE FROM qa_userevents WHERE userid=? AND updated<=?', [userid, row.updated]);
      }
    }

    return {
      ...shared,

      async findPost(postid, { lock = false } = {}) {
        const [[post]] = await db.execute(`SELECT ${POST_COLUMNS} FROM qa_posts WHERE postid=?${lock ? ' FOR UPDATE' : ''}`, [postid]);
        return post;
      },
      async findChildren(parentid) {
        const [rows] = await db.execute(`SELECT ${POST_COLUMNS} FROM qa_posts WHERE parentid=? ORDER BY postid`, [parentid]);
        return rows;
      },
      // qa_db_post_duplicates_selectspec(): the questions closed as duplicates of this one.
      async findDuplicates(questionid) {
        const [rows] = await db.execute(`SELECT ${POST_COLUMNS} FROM qa_posts WHERE closedbyid=? ORDER BY postid`, [questionid]);
        return rows;
      },
      // qa_db_qs_selectspec(null, 'created', 0, null, null, false, true, 5): the newest visible questions.
      async recentQuestions(count) {
        const [rows] = await db.query("SELECT title, content FROM qa_posts WHERE type='Q' ORDER BY created DESC LIMIT ?", [count]);
        return rows;
      },

      async countCategories() {
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM qa_categories');
        return Number(n);
      },
      // qa_category_path(): the category and its ancestors, from the top level down.
      async categoryPath(categoryid) {
        const path = [];
        let id = categoryid;
        while (id !== null && id !== undefined && path.length < 4) {
          const [[row]] = await db.execute('SELECT categoryid, parentid FROM qa_categories WHERE categoryid=?', [id]);
          if (!row) break;
          path.unshift(row);
          id = row.parentid;
        }
        return path;
      },

      // qa_cookie_get_create() / qa_db_cookie_create()
      async cookieExists(cookieid) {
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM qa_cookies WHERE cookieid=?', [cookieid]);
        return Number(n) > 0;
      },
      async createCookie(ip) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const cookieid = randomBytes(8).readBigUInt64BE().toString(); // qa_db_random_bigint()
          if (await this.cookieExists(cookieid)) continue;
          await db.query('INSERT INTO qa_cookies (cookieid, created, createip) VALUES (?, NOW(), INET6_ATON(?))', [cookieid, ip]);
          return cookieid;
        }
        return null;
      },

      // qa_db_post_create()
      async insertPost({ type, parentid, userid, cookieid, ip, title, content, format, tagstring, notify, categoryid, name }) {
        const [result] = await db.query(
          'INSERT INTO qa_posts (categoryid, type, parentid, userid, cookieid, createip, title, content, format, tags, notify, name, created) ' +
          'VALUES (?, ?, ?, ?, ?, INET6_ATON(?), ?, ?, ?, ?, ?, ?, NOW())',
          [categoryid, type, parentid, userid, cookieid, ip, title, content, format, tagstring, notify, name]);
        return result.insertId;
      },

      // qa_db_postmeta_set()
      async setPostMeta(postid, title, content) {
        await db.query('INSERT INTO qa_postmetas (postid, title, content) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)', [postid, title, content]);
      },

      // qa_db_posts_calc_category_path() (QA_CATEGORY_DEPTH=4)
      async calcCategoryPath(postid) {
        await db.query(
          'UPDATE qa_posts AS x, (SELECT qa_posts.postid, ' +
          'COALESCE(parent2.parentid, parent1.parentid, parent0.parentid, parent0.categoryid) AS catidpath1, ' +
          'IF (parent2.parentid IS NOT NULL, parent1.parentid, IF (parent1.parentid IS NOT NULL, parent0.parentid, IF (parent0.parentid IS NOT NULL, parent0.categoryid, NULL))) AS catidpath2, ' +
          'IF (parent2.parentid IS NOT NULL, parent0.parentid, IF (parent1.parentid IS NOT NULL, parent0.categoryid, NULL)) AS catidpath3 ' +
          'FROM qa_posts LEFT JOIN qa_categories AS parent0 ON qa_posts.categoryid=parent0.categoryid LEFT JOIN qa_categories AS parent1 ON parent0.parentid=parent1.categoryid LEFT JOIN qa_categories AS parent2 ON parent1.parentid=parent2.categoryid WHERE qa_posts.postid BETWEEN ? AND ?) AS a SET x.catidpath1=a.catidpath1, x.catidpath2=a.catidpath2, x.catidpath3=a.catidpath3 WHERE x.postid=a.postid',
          [postid, postid]);
      },

      // qa_db_category_path_qcount_update(qa_db_post_get_category_path($postid))
      async categoryPathQcountUpdate(postid) {
        const [[path]] = await db.execute('SELECT categoryid, catidpath1, catidpath2, catidpath3 FROM qa_posts WHERE postid=?', [postid]);
        if (!path) return;
        for (const id of [path.categoryid, path.catidpath1, path.catidpath2, path.catidpath3]) {
          if (id === null) continue;
          await db.query(
            "UPDATE qa_categories SET qcount=GREATEST( (SELECT COUNT(*) FROM qa_posts WHERE categoryid=? AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath1=? AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath2=? AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath3=? AND type='Q') ) WHERE categoryid=?",
            [id, id, id, id, id]);
        }
      },

      // qa_db_acount_update_for_q() with an increment.
      async acountUpdateForQ(questionid, increment) {
        await db.query('UPDATE qa_posts SET acount = ? + acount WHERE postid = ?', [increment, questionid]);
      },

      qcountUpdate: counted('cache_qcount', "SELECT COUNT(*) FROM qa_posts WHERE type = 'Q'"),
      acountUpdate: counted('cache_acount', "SELECT COUNT(*) FROM qa_posts WHERE type = 'A'"),
      ccountUpdate: counted('cache_ccount', "SELECT COUNT(*) FROM qa_posts WHERE type = 'C'"),
      unaqcountUpdate: counted('cache_unaqcount', "SELECT COUNT(*) FROM qa_posts WHERE type = 'Q' AND acount = 0 AND closedbyid IS NULL"),
      unselqcountUpdate: counted('cache_unselqcount', "SELECT COUNT(*) FROM qa_posts WHERE type = 'Q' AND selchildid IS NULL AND closedbyid IS NULL"),
      unupaqcountUpdate: counted('cache_unupaqcount', "SELECT COUNT(*) FROM qa_posts WHERE type = 'Q' AND amaxvote = 0 AND closedbyid IS NULL"),
      queuedcountUpdate: counted('cache_queuedcount', "SELECT COUNT(*) FROM qa_posts WHERE type IN ('Q_QUEUED', 'A_QUEUED', 'C_QUEUED')"),
      // qa_db_tagcount_update() always recounts.
      async tagcountUpdate() {
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM qa_words WHERE tagcount > 0');
        await db.query("INSERT INTO qa_options (title, content) VALUES ('cache_tagcount', ?) ON DUPLICATE KEY UPDATE content = VALUES(content)", [n]);
      },

      wordMapToIds,
      // qa_db_word_mapto_ids_add(). PHP also takes LOCK TABLES around the insert, which would commit
      // this transaction; INSERT IGNORE on the unique word index already resolves concurrent inserts.
      async wordMapToIdsAdd(words) {
        let wordtoid = await wordMapToIds(words);
        const missing = words.filter(word => !wordtoid.has(word));
        if (missing.length) {
          await db.query('INSERT IGNORE INTO qa_words (word) VALUES ?', [missing.map(word => [word])]);
          wordtoid = await wordMapToIds(words);
        }
        return wordtoid;
      },
      async addTitleWords(postid, wordids) {
        if (wordids.length) await db.query('INSERT INTO qa_titlewords (postid, wordid) VALUES ?', [wordids.map(id => [postid, id])]);
      },
      async addContentWords(postid, type, questionid, wordidcounts) {
        if (!wordidcounts.length) return;
        await db.query('INSERT INTO qa_contentwords (postid, wordid, count, type, questionid) VALUES ?',
          [wordidcounts.map(([id, count]) => [postid, id, Math.min(count, MAX_WORD_COUNT), type, questionid])]);
      },
      async addTagWords(postid, wordids) {
        if (wordids.length) await db.query('INSERT INTO qa_tagwords (postid, wordid) VALUES ?', [wordids.map(id => [postid, id])]);
      },
      async addPostTags(postid, wordids) {
        if (wordids.length) {
          await db.query('INSERT INTO qa_posttags (postid, wordid, postcreated) SELECT postid, wordid, created FROM qa_words, qa_posts WHERE postid=? AND wordid IN (?)', [postid, wordids]);
        }
      },
      // qa_db_word_titlecount_update() and its content/tagword/tag counterparts.
      async updateWordCounts(column, table, wordids) {
        if (!wordids.length) return;
        await db.query(
          `UPDATE qa_words AS x, (SELECT qa_words.wordid, COUNT(${table}.wordid) AS ${column} FROM qa_words LEFT JOIN ${table} ON ${table}.wordid=qa_words.wordid WHERE qa_words.wordid IN (?) GROUP BY wordid) AS a SET x.${column}=a.${column} WHERE x.wordid=a.wordid`,
          [wordids]);
      },

      // qa_db_event_create_for_entity()
      // timestamp (Unix seconds) is given when refilling the streams from old posts.
      async eventCreateForEntity(entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, timestamp = null) {
        await db.query(
          `INSERT INTO qa_sharedevents (entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated) VALUES (?, ?, ?, ?, ?, ?, ${timestamp === null ? 'NOW()' : 'FROM_UNIXTIME(?)'})`,
          [entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, ...(timestamp === null ? [] : [timestamp])]);
        let truncated = false;
        if (entitytype === 'Q') {
          const [[row]] = await db.query(
            'SELECT updated FROM qa_sharedevents WHERE entitytype=? AND entityid=? AND questionid=? ORDER BY updated DESC LIMIT ?,1', [entitytype, entityid, questionid, MAX_EVENTS_PER_Q]);
          if (row) {
            await db.query('DELETE FROM qa_sharedevents WHERE entitytype=? AND entityid=? AND questionid=? AND updated<=?', [entitytype, entityid, questionid, row.updated]);
            truncated = true;
          }
        }
        if (!truncated) {
          const [[row]] = await db.query('SELECT updated FROM qa_sharedevents WHERE entitytype=? AND entityid=? ORDER BY updated DESC LIMIT ?,1', [entitytype, entityid, maxStoreUserUpdates]);
          if (row) await db.query('DELETE FROM qa_sharedevents WHERE entitytype=? AND entityid=? AND updated<=?', [entitytype, entityid, row.updated]);
        }
        const [[favorite]] = await db.query('SELECT userid FROM qa_userfavorites WHERE entitytype=? AND entityid=? AND nouserevents=0 ORDER BY RAND() LIMIT 1', [entitytype, entityid]);
        if (favorite) {
          await db.query(
            'INSERT INTO qa_userevents (userid, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated) ' +
            `SELECT userid, ?, ?, ?, ?, ?, ?, ${timestamp === null ? 'NOW()' : 'FROM_UNIXTIME(?)'} FROM qa_userfavorites WHERE entitytype=? AND entityid=? AND nouserevents=0`,
            [entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, ...(timestamp === null ? [] : [timestamp]), entitytype, entityid]);
          await userEventsTruncate(favorite.userid, questionid);
        }
      },
      // qa_db_event_create_not_entity()
      async eventCreateNotEntity(userid, questionid, lastpostid, updatetype, lastuserid, timestamp = null) {
        await db.query(
          `INSERT INTO qa_userevents (userid, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated) VALUES (?, '-', 0, ?, ?, ?, ?, ${timestamp === null ? 'NOW()' : 'FROM_UNIXTIME(?)'})`,
          [userid, questionid, lastpostid, updatetype, lastuserid, ...(timestamp === null ? [] : [timestamp])]);
        await userEventsTruncate(userid, questionid);
      },

      // --- changing posts (db/post-update.php) ---
      async indexedWordIds(table, postid) {
        const [rows] = await db.query(`SELECT wordid FROM ${table} WHERE postid=?`, [postid]);
        return rows.map(row => row.wordid);
      },
      async deleteIndexed(table, postid) { await db.query(`DELETE FROM ${table} WHERE postid=?`, [postid]); },

      // Each setter records the editor (updated/updatetype/lastuserid/lastip) only when PHP passes them.
      async setContent(postid, { title, content, format, tagstring, notify, name }, edit) {
        const fields = 'title=?, content=?, format=?, tags=?, name=COALESCE(?, name), notify=?';
        const values = [title, content, format, tagstring, name, notify];
        if (edit) await db.query(`UPDATE qa_posts SET ${fields}, updated=NOW(), updatetype=?, lastuserid=?, lastip=INET6_ATON(?) WHERE postid=?`, [...values, edit.updatetype, edit.userid, edit.ip, postid]);
        else await db.query(`UPDATE qa_posts SET ${fields} WHERE postid=?`, [...values, postid]);
      },
      async setType(postid, type, edit) {
        if (edit) await db.query('UPDATE qa_posts SET type=?, updated=NOW(), updatetype=?, lastuserid=?, lastip=INET6_ATON(?) WHERE postid=?', [type, edit.updatetype, edit.userid, edit.ip, postid]);
        else await db.query('UPDATE qa_posts SET type=? WHERE postid=?', [type, postid]);
      },
      async setParent(postid, parentid) { await db.query('UPDATE qa_posts SET parentid=? WHERE postid=?', [parentid, postid]); },
      async setCategory(postid, categoryid, edit) {
        if (edit) await db.query("UPDATE qa_posts SET categoryid=?, updated=NOW(), updatetype='A', lastuserid=?, lastip=INET6_ATON(?) WHERE postid=?", [categoryid, edit.userid, edit.ip, postid]);
        else await db.query('UPDATE qa_posts SET categoryid=? WHERE postid=?', [categoryid, postid]);
      },
      async getCategoryPath(postid) {
        const [[row]] = await db.execute('SELECT categoryid, catidpath1, catidpath2, catidpath3 FROM qa_posts WHERE postid=?', [postid]);
        return row;
      },
      async setPostsCategoryPath(postids, path) {
        if (postids.length) await db.query('UPDATE qa_posts SET categoryid=?, catidpath1=?, catidpath2=?, catidpath3=? WHERE postid IN (?)', [path.categoryid, path.catidpath1, path.catidpath2, path.catidpath3, postids]);
      },
      // qa_db_category_path_qcount_update() for a path read earlier.
      async pathQcountUpdate(path) {
        for (const id of [path.categoryid, path.catidpath1, path.catidpath2, path.catidpath3]) {
          if (id === null || id === undefined) continue;
          await db.query(
            "UPDATE qa_categories SET qcount=GREATEST( (SELECT COUNT(*) FROM qa_posts WHERE categoryid=? AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath1=? AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath2=? AND type='Q'), (SELECT COUNT(*) FROM qa_posts WHERE catidpath3=? AND type='Q') ) WHERE categoryid=?",
            [id, id, id, id, id]);
        }
      },
      async setCreatedNow(postid) { await db.query('UPDATE qa_posts SET created=NOW() WHERE postid=?', [postid]); },
      async setUpdatedNow(postid) { await db.query('UPDATE qa_posts SET updated=NOW() WHERE postid=?', [postid]); },
      async deletePost(postid) { await db.query('DELETE FROM qa_posts WHERE postid=?', [postid]); },
      async setUserid(postid, userid) {
        await db.query('UPDATE qa_posts SET userid=?, lastuserid=IF(updated IS NULL, lastuserid, COALESCE(lastuserid,?)) WHERE postid=?', [userid, userid, postid]);
      },
      async uservoteRemoveOwn(postid) {
        await db.query('DELETE uv FROM qa_uservotes uv JOIN qa_posts p ON uv.postid=p.postid AND uv.userid=p.userid WHERE uv.postid=?', [postid]);
      },
      async recountVotes(postid) {
        await db.query(
          'UPDATE qa_posts AS x, (SELECT COALESCE(SUM(GREATEST(0,vote)),0) AS upvotes, -COALESCE(SUM(LEAST(0,vote)),0) AS downvotes FROM qa_uservotes WHERE postid=?) AS a SET x.upvotes=a.upvotes, x.downvotes=a.downvotes, x.netvotes=a.upvotes-a.downvotes WHERE x.postid=?',
          [postid, postid]);
      },
      // qa_db_uservote_post_get(): non-zero votes on a post, by user.
      async postUserVotes(postid) {
        const [rows] = await db.query('SELECT userid, vote FROM qa_uservotes WHERE postid=? AND vote!=0', [postid]);
        return rows;
      },
      async setSelchildid(questionid, selchildid, edit) {
        await db.query("UPDATE qa_posts AS x, (SELECT selchildid FROM qa_posts WHERE postid=?) AS a SET x.updated=NULL, x.updatetype=NULL, x.lastuserid=NULL, x.lastip=NULL WHERE x.postid=a.selchildid AND x.updatetype='S'", [questionid]);
        await db.query('UPDATE qa_posts SET selchildid=? WHERE postid=?', [selchildid, questionid]);
        if (selchildid !== null && edit) {
          await db.query("UPDATE qa_posts SET updated=NOW(), updatetype='S', lastuserid=?, lastip=INET6_ATON(?) WHERE postid=?", [edit.userid, edit.ip, selchildid]);
        }
      },
      async setClosed(questionid, closedbyid, edit) {
        if (edit) await db.query("UPDATE qa_posts SET closedbyid=?, updated=NOW(), updatetype='C', lastuserid=?, lastip=INET6_ATON(?) WHERE postid=?", [closedbyid, edit.userid, edit.ip, questionid]);
        else await db.query('UPDATE qa_posts SET closedbyid=? WHERE postid=?', [closedbyid, questionid]);
      },
      // qa_db_amaxvote_update_for_q(): add to it, set it, or recount it (value undefined). Returns rows changed.
      async amaxvoteUpdateForQ(questionid, value, relative = true) {
        let newValue = value;
        if (newValue === undefined) {
          [[{ newValue }]] = await db.query("SELECT COALESCE(GREATEST(MAX(netvotes), 0), 0) AS newValue FROM qa_posts WHERE parentid = ? AND type = 'A'", [questionid]);
        }
        const [result] = await db.query(`UPDATE qa_posts SET amaxvote = ? ${value !== undefined && relative ? '+ amaxvote ' : ''}WHERE postid = ?`, [newValue, questionid]);
        return result.changedRows;
      },
      async questionAmaxvote(questionid) {
        const [[row]] = await db.query('SELECT amaxvote FROM qa_posts WHERE postid=?', [questionid]);
        return Number(row.amaxvote);
      },
      // --- flags (db/votes.php, db/post-update.php) ---
      async userFlag(postid, userid) {
        const [[row]] = await db.query('SELECT flag FROM qa_uservotes WHERE postid=? AND userid=? FOR UPDATE', [postid, userid]);
        return row ? Number(row.flag) : 0;
      },
      // qa_db_userflag_set()
      async userflagSet(postid, userid, flag) {
        await db.query('INSERT INTO qa_uservotes (postid, userid, vote, flag) VALUES (?, ?, 0, ?) ON DUPLICATE KEY UPDATE flag=?', [postid, userid, flag ? 1 : 0, flag ? 1 : 0]);
      },
      // qa_db_post_recount_flags() with an increment
      async recountFlags(postid, increment) {
        await db.query('UPDATE qa_posts SET flagcount = flagcount + ? WHERE postid = ?', [increment, postid]);
      },
      // qa_db_userflags_clear_all(): returns the rows changed, as qa_db_affected_rows() does.
      async userflagsClearAll(postid) {
        const [result] = await db.query('UPDATE qa_uservotes SET flag=0 WHERE postid=?', [postid]);
        return result.changedRows;
      },
      // qa_db_post_reset_flags()
      async resetFlags(postid) { await db.query('UPDATE qa_posts SET flagcount = 0 WHERE postid = ?', [postid]); },
      flaggedcountUpdate: counted('cache_flaggedcount', "SELECT COUNT(*) FROM qa_posts WHERE flagcount > 0 AND type IN ('Q', 'A', 'C')"),
      // qa_db_posts_filter_q_postids()
      async filterQuestionIds(postids) {
        if (!postids.length) return [];
        const [rows] = await db.query("SELECT postid FROM qa_posts WHERE type='Q' AND postid IN (?)", [postids]);
        return rows.map(row => row.postid);
      },

      // Remembered for the event truncation queries, which read the option as (int).
      setMaxStoreUserUpdates(value) { maxStoreUserUpdates = phpInt(value); },
    };
  }

  return { transaction: createTransactor(pool, queries), queries };
}
module.exports = { createPostRepository };
