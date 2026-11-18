// SQL for creating questions, answers and comments, ported statement-by-statement from
// qa-include/db/post-create.php, db/events.php, db/cookies.php and db/selects.php.
const { randomBytes } = require('node:crypto');
const { createTransactor, sharedQueries } = require('./shared');
const { phpInt } = require('../q2a/php');

const MAX_EVENTS_PER_Q = 5; // QA_DB_MAX_EVENTS_PER_Q
const MAX_WORD_COUNT = 255; // QA_DB_MAX_WORD_COUNT
const POST_COLUMNS = "postid, type, LEFT(type, 1) AS basetype, INSTR(type, '_HIDDEN')>0 AS hidden, INSTR(type, '_QUEUED')>0 AS queued, " +
  'userid, cookieid, parentid, categoryid, acount, closedbyid, selchildid, lastuserid, flagcount, title, content, format, ' +
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
      async eventCreateForEntity(entitytype, entityid, questionid, lastpostid, updatetype, lastuserid) {
        await db.query(
          'INSERT INTO qa_sharedevents (entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated) VALUES (?, ?, ?, ?, ?, ?, NOW())',
          [entitytype, entityid, questionid, lastpostid, updatetype, lastuserid]);
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
            'SELECT userid, ?, ?, ?, ?, ?, ?, NOW() FROM qa_userfavorites WHERE entitytype=? AND entityid=? AND nouserevents=0',
            [entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, entitytype, entityid]);
          await userEventsTruncate(favorite.userid, questionid);
        }
      },
      // qa_db_event_create_not_entity()
      async eventCreateNotEntity(userid, questionid, lastpostid, updatetype, lastuserid) {
        await db.query(
          "INSERT INTO qa_userevents (userid, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid, updated) VALUES (?, '-', 0, ?, ?, ?, ?, NOW())",
          [userid, questionid, lastpostid, updatetype, lastuserid]);
        await userEventsTruncate(userid, questionid);
      },

      // Remembered for the event truncation queries, which read the option as (int).
      setMaxStoreUserUpdates(value) { maxStoreUserUpdates = phpInt(value); },
    };
  }

  return { transaction: createTransactor(pool, queries) };
}
module.exports = { createPostRepository };
