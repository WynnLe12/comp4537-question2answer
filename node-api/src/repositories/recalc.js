// SQL for the admin recalculation tools, ported from qa-include/db/recalc.php, with the post and
// category queries the steps share with other features.
const { createTransactor } = require('./shared');
const { createPostRepository } = require('./posts');
const { createSiteAdminRepository } = require('./site-admin');
const { phpNum, phpInt } = require('../q2a/php');
const { pointsCalculations } = require('../q2a/points');

const FAMILY_COLUMNS = "p.postid, p.type, LEFT(p.type, 1) AS basetype, p.parentid, p.userid, p.lastuserid, p.updatetype, p.tags, p.categoryid, " +
  'UNIX_TIMESTAMP(p.created) AS createdts, UNIX_TIMESTAMP(p.updated) AS updatedts';

function createRecalcRepository(pool) {
  const posts = createPostRepository(pool);
  const siteAdmin = createSiteAdminRepository(pool);
  function queries(db) {
    const shared = { ...posts.queries(db), ...siteAdmin.queries(db) };
    const counted = (key, sql) => increment => shared.cacheUpdate(key, sql, increment);
    return {
      ...shared,
      async countOf(sql, params = []) { const [[row]] = await db.query(sql, params); return Number(Object.values(row)[0]); },
      async rows(sql, params = []) { const [rows] = await db.query(sql, params); return rows; },
      async execute(sql, params = []) { await db.query(sql, params); },
      unupaqcountUpdate: counted('cache_unupaqcount', "SELECT COUNT(*) FROM qa_posts WHERE type='Q' AND amaxvote=0 AND closedbyid IS NULL"),
      userpointscountUpdate: counted('cache_userpointscount', 'SELECT COUNT(*) FROM qa_userpoints'),
      uapprovecountUpdate: counted('cache_uapprovecount', 'SELECT COUNT(*) FROM qa_users WHERE level < 10 AND NOT (flags & 2)'),

      // qa_db_posts_get_for_reindexing(): visible posts whose question (and parent) are visible
      async postsForReindexing(start, count) {
        const [rows] = await db.query(
          "SELECT qa_posts.postid, qa_posts.title, qa_posts.content, qa_posts.format, qa_posts.tags, qa_posts.categoryid, qa_posts.type, IF (qa_posts.type='Q', qa_posts.postid, IF(parent.type='Q', parent.postid, grandparent.postid)) AS questionid, qa_posts.parentid " +
          'FROM qa_posts LEFT JOIN qa_posts AS parent ON qa_posts.parentid=parent.postid LEFT JOIN qa_posts as grandparent ON parent.parentid=grandparent.postid ' +
          "WHERE qa_posts.postid>=? AND ( (qa_posts.type='Q') OR (qa_posts.type='A' AND parent.type<=>'Q') OR (qa_posts.type='C' AND parent.type<=>'Q') OR (qa_posts.type='C' AND parent.type<=>'A' AND grandparent.type<=>'Q') ) ORDER BY postid LIMIT ?",
          [start, count]);
        return rows;
      },
      // qa_db_prepare_for_reindexing(), qa_db_truncate_indexes()
      async prepareForReindexing(first, last) {
        for (const table of ['qa_titlewords', 'qa_contentwords', 'qa_tagwords', 'qa_posttags']) await db.query(`DELETE FROM ${table} WHERE postid>=? AND postid<=?`, [first, last]);
      },
      async truncateIndexes(first) {
        for (const table of ['qa_titlewords', 'qa_contentwords', 'qa_tagwords', 'qa_posttags']) await db.query(`DELETE FROM ${table} WHERE postid>=?`, [first]);
      },
      // qa_db_words_recount()
      async wordsRecount(first, last) {
        for (const [column, table] of [['titlecount', 'qa_titlewords'], ['contentcount', 'qa_contentwords'], ['tagwordcount', 'qa_tagwords'], ['tagcount', 'qa_posttags']]) {
          await db.query(
            `UPDATE qa_words AS x, (SELECT qa_words.wordid, COUNT(${table}.wordid) AS ${column} FROM qa_words LEFT JOIN ${table} ON ${table}.wordid=qa_words.wordid WHERE qa_words.wordid>=? AND qa_words.wordid<=? GROUP BY wordid) AS a SET x.${column}=a.${column} WHERE x.wordid=a.wordid`,
            [first, last]);
        }
        await db.query('DELETE FROM qa_words WHERE wordid>=? AND wordid<=? AND titlecount=0 AND contentcount=0 AND tagwordcount=0 AND tagcount=0', [first, last]);
      },
      // qa_db_posts_votes_recount(), qa_db_posts_answers_recount() (hotness follows in the step)
      async postsVotesRecount(first, last) {
        await db.query(
          'UPDATE qa_posts AS x, (SELECT qa_posts.postid, COALESCE(SUM(GREATEST(0,qa_uservotes.vote)),0) AS upvotes, -COALESCE(SUM(LEAST(0,qa_uservotes.vote)),0) AS downvotes, COALESCE(SUM(IF(qa_uservotes.flag, 1, 0)),0) AS flagcount FROM qa_posts LEFT JOIN qa_uservotes ON qa_uservotes.postid=qa_posts.postid WHERE qa_posts.postid>=? AND qa_posts.postid<=? GROUP BY postid) AS a SET x.upvotes=a.upvotes, x.downvotes=a.downvotes, x.netvotes=a.upvotes-a.downvotes, x.flagcount=a.flagcount WHERE x.postid=a.postid',
          [first, last]);
      },
      async postsAnswersRecount(first, last) {
        await db.query(
          "UPDATE qa_posts AS x, (SELECT parents.postid, COUNT(children.postid) AS acount, COALESCE(GREATEST(MAX(children.netvotes), 0), 0) AS amaxvote FROM qa_posts AS parents LEFT JOIN qa_posts AS children ON parents.postid=children.parentid AND children.type='A' WHERE parents.postid>=? AND parents.postid<=? GROUP BY postid) AS a SET x.acount=a.acount, x.amaxvote=a.amaxvote WHERE x.postid=a.postid",
          [first, last]);
      },
      // qa_db_hotness_update() for a range of posts
      async hotnessUpdateRange(first, last, options) {
        const o = name => phpNum(options.get(name));
        await db.query(
          "UPDATE qa_posts AS x, (SELECT parents.postid, MAX(parents.created) AS qcreated, COALESCE(MAX(children.created), MAX(parents.created)) as acreated, COUNT(children.postid) AS acount, MAX(parents.netvotes) AS netvotes, MAX(parents.views) AS views FROM qa_posts AS parents LEFT JOIN qa_posts AS children ON parents.postid=children.parentid AND children.type='A' WHERE parents.postid BETWEEN ? AND ? GROUP BY postid) AS a SET x.hotness=(" +
          '((TO_DAYS(a.qcreated)-734138)*86400.0+TIME_TO_SEC(a.qcreated))*? + ((TO_DAYS(a.acreated)-734138)*86400.0+TIME_TO_SEC(a.acreated))*? + ' +
          '(a.acount+0.0)*? + (a.netvotes+0.0)*? + (a.views+0.0)*?) WHERE x.postid=a.postid',
          [first, last, o('hot_weight_q_age'), o('hot_weight_a_age'), o('hot_weight_answers') * 160000, o('hot_weight_votes') * 160000, o('hot_weight_views') * 4000]);
      },
      // qa_db_users_recalc_points()
      async usersRecalcPoints(first, last, options) {
        const calculations = pointsCalculations(options);
        await db.query('DELETE FROM qa_userpoints WHERE userid>=? AND userid<=? AND bonus=0', [first, last]);
        await db.query(`UPDATE qa_userpoints SET points=0, ${Object.keys(calculations).map(field => `${field}=0`).join(', ')} WHERE userid>=? AND userid<=?`, [first, last]);
        await db.query('INSERT IGNORE INTO qa_userpoints (userid) SELECT DISTINCT userid FROM qa_users WHERE userid>=? AND userid<=?', [first, last]);
        let updatepoints = String(phpInt(options.get('points_base')));
        for (const [field, calculation] of Object.entries(calculations)) {
          await db.query(
            `UPDATE qa_userpoints, (SELECT userid_src.userid, ${calculation.formula.replace(/~/g, ' BETWEEN ? AND ?')} GROUP BY userid) AS results SET qa_userpoints.${field}=results.${field} WHERE qa_userpoints.userid=results.userid`,
            [first, last]);
          updatepoints += `+(${Math.trunc(calculation.multiple)}*${field})`;
        }
        await db.query(`UPDATE qa_userpoints SET points=${updatepoints}+bonus WHERE userid>=? AND userid<=?`, [first, last]);
      },
      // The question, its children and its answers' children (qa_db_full_*_selectspec())
      async questionFamily(questionid) {
        const [rows] = await db.query(
          `SELECT ${FAMILY_COLUMNS} FROM qa_posts AS p WHERE p.postid=? UNION ALL SELECT ${FAMILY_COLUMNS} FROM qa_posts AS p WHERE p.parentid=? ` +
          `UNION ALL SELECT ${FAMILY_COLUMNS} FROM qa_posts AS p JOIN qa_posts AS parent ON p.parentid=parent.postid WHERE parent.parentid=? AND LEFT(parent.type, 1)='A'`,
          [questionid, questionid, questionid]);
        return rows.map(row => ({ ...row, createdts: row.createdts === null ? null : Number(row.createdts), updatedts: row.updatedts === null ? null : Number(row.updatedts) }));
      },
      // qa_db_posts_recalc_categoryid()
      async postsRecalcCategoryid(first, last) {
        await db.query(
          "UPDATE qa_posts AS x, (SELECT qa_posts.postid, IF(LEFT(parent.type, 1)='Q', parent.categoryid, grandparent.categoryid) AS categoryid FROM qa_posts LEFT JOIN qa_posts AS parent ON qa_posts.parentid=parent.postid LEFT JOIN qa_posts AS grandparent ON parent.parentid=grandparent.postid WHERE qa_posts.postid BETWEEN ? AND ? AND LEFT(qa_posts.type, 1)!='Q') AS a SET x.categoryid=a.categoryid WHERE x.postid=a.postid",
          [first, last]);
      },
      // qa_db_posts_calc_category_path() for a range
      async postsCalcCategoryPathRange(first, last) {
        await db.query(
          'UPDATE qa_posts AS x, (SELECT qa_posts.postid, ' +
          'COALESCE(parent2.parentid, parent1.parentid, parent0.parentid, parent0.categoryid) AS catidpath1, ' +
          'IF (parent2.parentid IS NOT NULL, parent1.parentid, IF (parent1.parentid IS NOT NULL, parent0.parentid, IF (parent0.parentid IS NOT NULL, parent0.categoryid, NULL))) AS catidpath2, ' +
          'IF (parent2.parentid IS NOT NULL, parent0.parentid, IF (parent1.parentid IS NOT NULL, parent0.categoryid, NULL)) AS catidpath3 ' +
          'FROM qa_posts LEFT JOIN qa_categories AS parent0 ON qa_posts.categoryid=parent0.categoryid LEFT JOIN qa_categories AS parent1 ON parent0.parentid=parent1.categoryid LEFT JOIN qa_categories AS parent2 ON parent1.parentid=parent2.categoryid WHERE qa_posts.postid BETWEEN ? AND ?) AS a SET x.catidpath1=a.catidpath1, x.catidpath2=a.catidpath2, x.catidpath3=a.catidpath3 WHERE x.postid=a.postid',
          [first, last]);
      },
      // qa_db_posts_get_for_deleting(): hidden posts with no children and not a duplicate's original
      async postsForDeleting(type, start = 0, limit = null) {
        const [rows] = await db.query(
          'SELECT qa_posts.postid FROM qa_posts LEFT JOIN qa_posts AS child ON child.parentid=qa_posts.postid LEFT JOIN qa_posts AS dupe ON dupe.closedbyid=qa_posts.postid ' +
          `WHERE qa_posts.type=? AND qa_posts.postid>=? AND child.postid IS NULL AND dupe.postid IS NULL${limit === null ? '' : ` ORDER BY qa_posts.postid LIMIT ${Number(limit)}`}`,
          [`${type}_HIDDEN`, start]);
        return rows.map(row => Number(row.postid));
      },
    };
  }
  return { transaction: createTransactor(pool, queries) };
}
module.exports = { createRecalcRepository };
