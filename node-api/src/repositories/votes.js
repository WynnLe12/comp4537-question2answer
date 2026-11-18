// SQL for voting, ported statement-by-statement from qa-include/db/votes.php, db/points.php,
// db/hotness.php, db/post-create.php, db/options.php, db/limits.php and db/users.php.
const { createTransactor, sharedQueries } = require('./shared');

function createVoteRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    return {
      ...shared,
      findVoter: shared.findActor,

      // Columns of qa_db_full_post_selectspec() that voting reads.
      async findPost(postid) {
        const [[post]] = await db.execute(
          "SELECT postid, type, LEFT(type, 1) AS basetype, INSTR(type, '_HIDDEN')>0 AS hidden, INSTR(type, '_QUEUED')>0 AS queued, " +
          "userid, parentid, netvotes, CONCAT_WS(',', catidpath1, catidpath2, catidpath3, categoryid) AS categoryids " +
          'FROM qa_posts WHERE postid=? FOR UPDATE', [postid]);
        return post;
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

      unupaqcountUpdate: increment => shared.cacheUpdate('cache_unupaqcount',
        "SELECT COUNT(*) FROM qa_posts WHERE type = 'Q' AND amaxvote = 0 AND closedbyid IS NULL", increment),

      async postVotes(postid) {
        const [[row]] = await db.execute('SELECT upvotes, downvotes, netvotes FROM qa_posts WHERE postid=?', [postid]);
        return row;
      },
    };
  }

  return { transaction: createTransactor(pool, queries) };
}
module.exports = { createVoteRepository };
