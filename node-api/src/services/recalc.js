// The admin recalculation tools: a port of qa_recalc_perform_step(), qa_recalc_transition() and
// qa_recalc_stage_length() (qa-include/app/recalc.php) with the functions of db/recalc.php. A state is
// "operation\tlength\tnext\tdone", as in PHP; each step does a small batch and returns the next state.
// Moving blobs to or from disk does nothing here (Node keeps blobs in the database, as the Docker
// setup does), and the file cache belongs to the PHP pages.
const { ApiError } = require('../errors');
const { LEVEL } = require('../q2a/permissions');
const { phpInt } = require('../q2a/php');
const text = require('../q2a/text');
const { pointsCalculations } = require('../q2a/points');
const { createPostHelpers } = require('./post-common');

const UPDATE = { FOLLOWS: 'Y', C_FOR_Q: 'U', C_FOR_A: 'N' }; // QA_UPDATE_*
const OPERATIONS = ['dorecountposts', 'doreindexcontent', 'dorecalcpoints', 'dorefillevents', 'dorecalccategories', 'dodeletehidden', 'doblobstodisk', 'doblobstodb'];

function createRecalcService(repository, { identify, postChangeService }) {
  const { indexPost, unindexPost } = createPostHelpers({ identify });

  const parse = state => {
    const [operation = '', length = '0', next = '0', done = '0'] = String(state ?? '').split('\t');
    return { operation, length: phpInt(length), next: phpInt(next), done: phpInt(done) };
  };
  const format = ({ operation, length, next, done }) => `${operation}\t${length}\t${next}\t${done}`;

  // qa_recalc_stage_length()
  async function stageLength(q, operation, options) {
    const n = Number;
    switch (operation) {
      case 'doreindexcontent_pagereindex': return q.countOf('SELECT COUNT(*) FROM qa_pages');
      case 'doreindexcontent_postreindex': return n(options.get('cache_qcount')) + n(options.get('cache_acount')) + n(options.get('cache_ccount'));
      case 'doreindexposts_wordcount': return q.countOf('SELECT COUNT(*) FROM qa_words');
      case 'dorecalcpoints_recalc': return n(options.get('cache_userpointscount'));
      case 'dorecountposts_votecount': case 'dorecountposts_acount': case 'dorecalccategories_postupdate': return q.countOf('SELECT COUNT(*) FROM qa_posts');
      case 'dorefillevents_refill': return n(options.get('cache_qcount')) + await q.countOf("SELECT COUNT(*) FROM qa_posts WHERE type='Q_HIDDEN'");
      case 'dorecalccategories_recount': case 'dorecalccategories_backpaths': return q.countOf('SELECT COUNT(*) FROM qa_categories');
      case 'dodeletehidden_comments': return (await q.postsForDeleting('C')).length;
      case 'dodeletehidden_answers': return (await q.postsForDeleting('A')).length;
      case 'dodeletehidden_questions': return (await q.postsForDeleting('Q')).length;
      default: return 0;
    }
  }
  // qa_recalc_transition()
  async function transition(q, operation, options) {
    return { operation, length: await stageLength(q, operation, options), next: 0, done: 0 };
  }

  // qa_recalc_perform_step(): one batch. Returns the new state and whether to keep going.
  async function performStep(q, state, options, request) {
    let { operation, length, next, done } = parse(state);
    let proceed = false;
    let result = null; // a transition
    switch (operation) {
      case 'doreindexcontent': result = await transition(q, 'doreindexcontent_pagereindex', options); break;
      case 'doreindexcontent_pagereindex': {
        // The built-in search module does not index custom pages, so only the count moves on.
        const pages = await q.rows('SELECT pageid FROM qa_pages WHERE pageid>=? ORDER BY pageid LIMIT 10', [next]);
        if (pages.length) {
          next = 1 + Math.max(...pages.map(p => Number(p.pageid)));
          done += pages.length;
          proceed = true;
        } else result = await transition(q, 'doreindexcontent_postcount', options);
        break;
      }
      case 'doreindexcontent_postcount':
        await q.qcountUpdate(); await q.acountUpdate(); await q.ccountUpdate();
        result = await transition(q, 'doreindexcontent_postreindex', await q.loadOptions());
        break;
      case 'doreindexcontent_postreindex': {
        const posts = await q.postsForReindexing(next, 10);
        if (posts.length) {
          const last = Math.max(...posts.map(p => Number(p.postid)));
          await q.prepareForReindexing(next, last);
          for (const post of posts) {
            await unindexPostWithoutCounts(q, post.postid);
            await indexPost(q, post.postid, post.type, post.questionid, post.title, text.viewerText(post.content ?? '', post.format ?? ''), post.tags, { updateCounts: false });
          }
          next = 1 + last;
          done += posts.length;
          proceed = true;
        } else {
          await q.truncateIndexes(next);
          result = await transition(q, 'doreindexposts_wordcount', options);
        }
        break;
      }
      case 'doreindexposts_wordcount': {
        const wordids = (await q.rows('SELECT wordid FROM qa_words WHERE wordid>=? ORDER BY wordid LIMIT 1000', [next])).map(r => Number(r.wordid));
        if (wordids.length) {
          const last = Math.max(...wordids);
          await q.wordsRecount(next, last);
          next = 1 + last;
          done += wordids.length;
          proceed = true;
        } else {
          await q.tagcountUpdate();
          result = await transition(q, 'doreindexposts_complete', options);
        }
        break;
      }
      case 'dorecountposts': result = await transition(q, 'dorecountposts_postcount', options); break;
      case 'dorecountposts_postcount':
        await q.qcountUpdate(); await q.acountUpdate(); await q.ccountUpdate(); await q.unaqcountUpdate(); await q.unselqcountUpdate();
        result = await transition(q, 'dorecountposts_votecount', options);
        break;
      case 'dorecountposts_votecount': case 'dorecountposts_acount': {
        const postids = (await q.rows('SELECT postid FROM qa_posts WHERE postid>=? ORDER BY postid LIMIT 1000', [next])).map(r => Number(r.postid));
        if (postids.length) {
          const last = Math.max(...postids);
          if (operation === 'dorecountposts_votecount') await q.postsVotesRecount(next, last);
          else await q.postsAnswersRecount(next, last);
          await q.hotnessUpdateRange(next, last, options);
          next = 1 + last;
          done += postids.length;
          proceed = true;
        } else if (operation === 'dorecountposts_votecount') result = await transition(q, 'dorecountposts_acount', options);
        else {
          await q.unupaqcountUpdate();
          result = await transition(q, 'dorecountposts_complete', options);
        }
        break;
      }
      case 'dorecalcpoints': result = await transition(q, 'dorecalcpoints_usercount', options); break;
      case 'dorecalcpoints_usercount':
        await q.userpointscountUpdate();
        await q.uapprovecountUpdate();
        result = await transition(q, 'dorecalcpoints_recalc', await q.loadOptions());
        break;
      case 'dorecalcpoints_recalc': {
        let recalccount = 10;
        const userids = (await q.rows('SELECT DISTINCT userid FROM qa_users WHERE userid>=? ORDER BY userid LIMIT ?', [next, recalccount + 1])).map(r => Number(r.userid));
        recalccount = Math.min(recalccount, userids.length);
        let lastuserid = next;
        if (recalccount > 0) {
          lastuserid = userids[recalccount - 1];
          await q.usersRecalcPoints(next, lastuserid, options);
          done += recalccount;
        }
        if (userids.length > recalccount) {
          next = userids[recalccount];
          proceed = true;
        } else {
          await q.execute('DELETE FROM qa_userpoints WHERE userid>?', [lastuserid]);
          await q.userpointscountUpdate();
          result = await transition(q, 'dorecalcpoints_complete', options);
        }
        break;
      }
      case 'dorefillevents': result = await transition(q, 'dorefillevents_qcount', options); break;
      case 'dorefillevents_qcount':
        await q.qcountUpdate();
        result = await transition(q, 'dorefillevents_refill', await q.loadOptions());
        break;
      case 'dorefillevents_refill': {
        const questionids = (await q.rows("SELECT postid FROM qa_posts WHERE postid>=? AND LEFT(type, 1)='Q' ORDER BY postid LIMIT 1", [next])).map(r => Number(r.postid));
        if (questionids.length) {
          for (const questionid of questionids) await refillEvents(q, questionid);
          next = 1 + Math.max(...questionids);
          done += questionids.length;
          proceed = true;
        } else result = await transition(q, 'dorefillevents_complete', options);
        break;
      }
      case 'dorecalccategories': result = await transition(q, 'dorecalccategories_postcount', options); break;
      case 'dorecalccategories_postcount':
        await q.acountUpdate(); await q.ccountUpdate();
        result = await transition(q, 'dorecalccategories_postupdate', options);
        break;
      case 'dorecalccategories_postupdate': {
        const postids = (await q.rows('SELECT postid FROM qa_posts WHERE postid>=? ORDER BY postid LIMIT 100', [next])).map(r => Number(r.postid));
        if (postids.length) {
          const last = Math.max(...postids);
          await q.postsRecalcCategoryid(next, last);
          await q.postsCalcCategoryPathRange(next, last);
          next = 1 + last;
          done += postids.length;
          proceed = true;
        } else result = await transition(q, 'dorecalccategories_recount', options);
        break;
      }
      case 'dorecalccategories_recount': case 'dorecalccategories_backpaths': {
        const categoryids = (await q.rows('SELECT categoryid FROM qa_categories WHERE categoryid>=? ORDER BY categoryid LIMIT 10', [next])).map(r => Number(r.categoryid));
        if (categoryids.length) {
          const last = Math.max(...categoryids);
          if (operation === 'dorecalccategories_recount') for (const id of categoryids) await q.pathQcountUpdate({ categoryid: id });
          else await q.categoriesRecalcBackpaths(next, last);
          next = 1 + last;
          done += categoryids.length;
          proceed = true;
        } else result = await transition(q, operation === 'dorecalccategories_recount' ? 'dorecalccategories_backpaths' : 'dorecalccategories_complete', options);
        break;
      }
      case 'dodeletehidden': result = await transition(q, 'dodeletehidden_comments', options); break;
      case 'dodeletehidden_comments': case 'dodeletehidden_answers': case 'dodeletehidden_questions': {
        const type = { dodeletehidden_comments: 'C', dodeletehidden_answers: 'A', dodeletehidden_questions: 'Q' }[operation];
        const postids = await q.postsForDeleting(type, next, 1);
        if (postids.length) {
          // qa_post_delete(), as the post change service deletes a hidden post (it commits on its own).
          q.afterCommit.push(() => postChangeService.deletePost({ token: request.token, ip: request.ip, postid: postids[0] }));
          next = 1 + postids[0];
          done++;
          proceed = true;
        } else result = await transition(q, operation === 'dodeletehidden_comments' ? 'dodeletehidden_answers' : operation === 'dodeletehidden_answers' ? 'dodeletehidden_questions' : 'dodeletehidden_complete', options);
        break;
      }
      case 'doblobstodisk': result = await transition(q, 'doblobstodisk_complete', options); break;
      case 'doblobstodb': result = await transition(q, 'doblobstodb_complete', options); break;
      default:
        return { state: '', proceed: false };
    }
    if (result) return { state: format(result), proceed: false };
    const nextState = { operation, length, next, done };
    return { state: format(nextState), proceed: proceed && done < length };
  }

  // qa_post_unindex() while counts are suspended: the rows go, the counts are recounted later.
  async function unindexPostWithoutCounts(q, postid) {
    for (const table of ['qa_titlewords', 'qa_contentwords', 'qa_tagwords', 'qa_posttags']) await q.deleteIndexed(table, postid);
  }

  // dorefillevents_refill for one question: every post's creation and last edit, the question's tags
  // and categories, and earlier commenters on each comment thread, each at its original time.
  async function refillEvents(q, questionid) {
    const posts = new Map();
    for (const post of await q.questionFamily(questionid)) posts.set(Number(post.postid), post);
    const question = posts.get(questionid);
    const parentOf = post => posts.get(Number(post.parentid));
    for (const [postid, post] of posts) {
      const followonq = post.basetype === 'Q' && postid !== questionid;
      let updatetype = null;
      if (followonq) updatetype = UPDATE.FOLLOWS;
      else if (post.basetype === 'C' && parentOf(post)?.basetype === 'Q') updatetype = UPDATE.C_FOR_Q;
      else if (post.basetype === 'C' && parentOf(post)?.basetype === 'A') updatetype = UPDATE.C_FOR_A;
      await eventForQUser(q, questionid, postid, updatetype, post.userid, parentOf(post)?.userid ?? null, post.createdts);
      if (post.updatedts !== null && !followonq) await eventForQUser(q, questionid, postid, post.updatetype, post.lastuserid, post.userid, post.updatedts);
    }
    for (const wordid of (await q.wordMapToIds([...new Set(text.tagstringToTags(question.tags))])).values()) {
      await q.eventCreateForEntity('T', wordid, questionid, questionid, null, question.userid, question.createdts);
    }
    if (question.categoryid !== null) {
      for (const category of await q.categoryPath(question.categoryid)) {
        await q.eventCreateForEntity('C', category.categoryid, questionid, questionid, null, question.userid, question.createdts);
      }
    }
    const threads = new Map();
    for (const post of posts.values()) {
      if (post.basetype !== 'C') continue;
      if (!threads.has(String(post.parentid))) threads.set(String(post.parentid), []);
      threads.get(String(post.parentid)).push(post);
    }
    for (const [parentid, comments] of threads) {
      const keyuserids = new Set();
      comments.sort((a, b) => a.createdts - b.createdts);
      for (const comment of comments) {
        for (const keyuserid of keyuserids) {
          if (keyuserid !== String(comment.userid) && keyuserid !== String(posts.get(Number(parentid))?.userid)) {
            await q.eventCreateNotEntity(keyuserid, questionid, comment.postid, UPDATE.FOLLOWS, comment.userid, comment.createdts);
          }
        }
        if (comment.userid !== null) keyuserids.add(String(comment.userid));
      }
    }
  }
  // qa_create_event_for_q_user() with a timestamp
  async function eventForQUser(q, questionid, lastpostid, updatetype, lastuserid, otheruserid, timestamp) {
    await q.eventCreateForEntity('Q', questionid, questionid, lastpostid, updatetype, lastuserid, timestamp);
    if (lastuserid !== null) await q.eventCreateForEntity('U', lastuserid, questionid, lastpostid, updatetype, lastuserid, timestamp);
    if (otheruserid !== null && otheruserid !== undefined && String(otheruserid) !== String(lastuserid)) {
      await q.eventCreateNotEntity(otheruserid, questionid, lastpostid, updatetype, lastuserid, timestamp);
    }
  }

  // Advance { state } for up to { seconds } (the PHP pages run steps for 2-3 seconds at a time).
  async function perform(request) {
    const identity = await identify(request.token);
    if (!identity) throw new ApiError(401, 'unauthenticated');
    let state = String(request.body?.state ?? '');
    const first = parse(state).operation;
    if (!OPERATIONS.includes(first) && !/^(do[a-z]+)_[a-z]+$/.test(first)) throw new ApiError(400, 'invalid_input', { state: 'invalid' });
    const stopAt = Date.now() + Math.min(Math.max(Number(request.body?.seconds ?? 0), 0), 10) * 1000;
    for (;;) {
      const step = await repository.transaction(async q => {
        const actor = await q.findActor(identity.id);
        if (!actor || Number(actor.level) < LEVEL.ADMIN) throw new ApiError(403, 'no_privileges');
        const options = await q.loadOptions();
        q.setMaxStoreUserUpdates(options.get('max_store_user_updates'));
        return performStep(q, state, options, request);
      });
      state = step.state;
      if (!step.proceed || Date.now() >= stopAt) break;
    }
    return { state };
  }

  return { perform, parse, pointsCalculations };
}
module.exports = { createRecalcService, OPERATIONS };
