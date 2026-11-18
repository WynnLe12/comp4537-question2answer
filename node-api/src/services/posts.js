// Creating questions, answers and comments. Ports, in PHP's order:
// - checks from pages/ask.php, pages/question-post.php (answer/comment permission switch),
//   pages/question-submit.php (qa_page_q_add_a_submit / qa_page_q_add_c_submit) and the
//   button rules of qa_page_q_post_rules() in pages/question-view.php;
// - input rules of the basic filter module (plugins/qa-filter-basic.php);
// - qa_question_create(), qa_answer_create(), qa_comment_create() (app/post-create.php);
// - the built-in modules those trigger: qa_search_basic (word index), qa_event_limits and qa_event_updates.
const { ApiError } = require('../errors');
const { phpBool, phpInt } = require('../q2a/php');
const { LIMIT, userLevelForPost, userLevelForCategories, userLevelMaximum, moderationReason, postIsByUser } = require('../q2a/permissions');
const text = require('../q2a/text');
const { UPDATE, permitFailure, stringField, readCommon, readId, filterQuestion, filterChild, sameWords, createPostHelpers } = require('./post-common');

function createPostService(repository, { identify }) {
  const { context, permit, postCookie, viewable, checkQuestionPage, indexPost, eventForQUser, reportWrite, checkCaptcha } = createPostHelpers({ identify });

  async function createQuestion(request) {
    return repository.transaction(async q => {
      const ctx = await context(q, request);
      const { options, body } = { ...ctx, body: request.body ?? {} };
      const usingTags = String(options.get('tags_or_categories')).includes('t');
      const usingCategories = String(options.get('tags_or_categories')).includes('c');

      // pages/ask.php: category and follow-on answer lookups, then the page-level permission.
      let categoryid = readId(body.categoryid, 'categoryid');
      const path = categoryid !== null ? await q.categoryPath(categoryid) : [];
      if (!path.length) categoryid = null;
      const followid = readId(body.followAnswerId, 'followAnswerId');
      let followanswer = followid !== null ? await q.findPost(followid) : null;
      if (followanswer?.basetype !== 'A') followanswer = null;

      const limits = await q.findLimits(ctx.userid, ctx.ip, LIMIT.QUESTIONS);
      const pageError = permit(ctx, 'permit_post_q', userLevelMaximum(ctx.user), LIMIT.QUESTIONS, limits);
      if (pageError) throw new ApiError(...permitFailure(pageError, 'ask'));

      const tagsInput = Array.isArray(body.tags) && body.tags.every(tag => typeof tag === 'string')
        ? body.tags.join(phpBool(options.get('tag_separator_comma')) ? ',' : ' ') : body.tags;
      if (tagsInput !== undefined && tagsInput !== null && typeof tagsInput !== 'string') throw new ApiError(400, 'invalid_input', { tags: 'invalid' });
      const input = {
        title: text.removeUtf8mb4(stringField(body, 'title') ?? ''),
        tags: usingTags ? text.tagsFromInput(tagsInput, phpBool(options.get('tag_separator_comma'))) : undefined,
        ...readCommon(body, options),
        extra: phpBool(options.get('extra_field_active')) ? stringField(body, 'extra') : null,
      };
      const userlevel = userLevelForCategories(path.map(row => row.categoryid), ctx.user);
      const queued = moderationReason(userlevel, ctx.user, ctx.ip, options) !== false;

      const errors = filterQuestion(input, options);
      if (usingCategories && await q.countCategories() && !phpBool(options.get('allow_no_category')) && categoryid === null) {
        errors.categoryid = 'required';
      } else if (permit(ctx, 'permit_post_q', userlevel)) {
        errors.categoryid = 'not_allowed';
      }
      checkCaptcha(ctx, null, 'captcha_on_anon_post');
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);

      for (const recent of await q.recentQuestions(5)) {
        if (sameWords(recent.title, input.title) && sameWords(recent.content, input.content)) throw new ApiError(409, 'duplicate_content');
      }

      // qa_question_create()
      const cookie = await postCookie(ctx);
      const tagstring = input.tags ? text.tagsToTagstring(input.tags) : '';
      const postid = await q.insertPost({
        type: queued ? 'Q_QUEUED' : 'Q', parentid: followanswer?.postid ?? null, userid: ctx.userid,
        cookieid: ctx.userid === null ? cookie.cookieid : null, ip: ctx.ip, title: input.title, content: input.content,
        format: input.format, tagstring, notify: text.combineNotifyEmail(ctx.userid, input.notify, input.email),
        categoryid, name: ctx.userid === null ? input.name : null,
      });
      if (input.extra !== null) await q.setPostMeta(postid, 'qa_q_extra', input.extra);
      await q.calcCategoryPath(postid);
      await q.updateHotness(postid, options);
      if (queued) {
        await q.queuedcountUpdate(1);
      } else {
        await indexPost(q, postid, 'Q', postid, input.title, input.text, tagstring);
        // qa_update_counts_for_q($postid, 1)
        await q.categoryPathQcountUpdate(postid);
        await q.qcountUpdate(1);
        await q.unaqcountUpdate(1);
        await q.unselqcountUpdate(1);
        await q.unupaqcountUpdate(1);
        await q.tagcountUpdate();
        await q.updatePoints(ctx.userid, ['qposts'], options);
      }

      await reportWrite(ctx, cookie.cookieid, LIMIT.QUESTIONS);
      if (!queued) { // qa_event_updates, q_post
        if (followanswer) await eventForQUser(q, followanswer.parentid, postid, UPDATE.FOLLOWS, ctx.userid, followanswer.userid);
        await eventForQUser(q, postid, postid, null, ctx.userid);
        for (const wordid of (await q.wordMapToIds([...new Set(text.tagstringToTags(tagstring))])).values()) {
          await q.eventCreateForEntity('T', wordid, postid, postid, null, ctx.userid);
        }
        for (const category of path) await q.eventCreateForEntity('C', category.categoryid, postid, postid, null, ctx.userid);
      }
      return { id: postid, type: queued ? 'Q_QUEUED' : 'Q', queued, cookieid: cookie.created ? cookie.cookieid : undefined };
    });
  }

  async function createAnswer(request) {
    return repository.transaction(async q => {
      const ctx = await context(q, request);
      const { options } = ctx;
      const body = request.body ?? {};
      const question = request.questionid ? await q.findPost(request.questionid, { lock: true }) : undefined;
      checkQuestionPage(ctx, question);
      const children = await q.findChildren(question.postid);
      const answers = children.filter(post => ['A', 'A_HIDDEN', 'A_QUEUED'].includes(post.type));
      const userlevel = userLevelForPost(question, ctx.user);

      // qa_page_q_post_rules(): is the answer button shown at all?
      const closed = question.closedbyid !== null || (question.selchildid !== null && phpBool(options.get('do_close_on_select')));
      const isbyuser = postIsByUser(question, ctx.userid, ctx.cookieid);
      const alreadyAnswered = answers.some(answer => postIsByUser(answer, ctx.userid, ctx.cookieid));
      if (question.type !== 'Q' || permit(ctx, 'permit_post_a', userlevel) === 'level' || closed ||
        (!phpBool(options.get('allow_self_answer')) && isbyuser) || (alreadyAnswered && !phpBool(options.get('allow_multi_answers')))) {
        throw new ApiError(403, 'answer_not_allowed');
      }
      const limits = await q.findLimits(ctx.userid, ctx.ip, LIMIT.ANSWERS);
      const permitError = permit(ctx, 'permit_post_a', userlevel, LIMIT.ANSWERS, limits);
      if (permitError) throw new ApiError(...permitFailure(permitError, 'answer'));

      // qa_page_q_add_a_submit()
      const input = readCommon(body, options);
      const queued = moderationReason(userlevel, ctx.user, ctx.ip, options) !== false;
      const errors = filterChild(input, 'min_len_a_content', options);
      checkCaptcha(ctx, userlevel, 'captcha_on_anon_post');
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);
      if (answers.some(answer => !Number(answer.hidden) && sameWords(answer.content, input.content))) throw new ApiError(409, 'duplicate_content');

      // qa_answer_create()
      const cookie = await postCookie(ctx);
      const postid = await q.insertPost({
        type: queued ? 'A_QUEUED' : 'A', parentid: question.postid, userid: ctx.userid,
        cookieid: ctx.userid === null ? cookie.cookieid : null, ip: ctx.ip, title: null, content: input.content, format: input.format,
        tagstring: null, notify: text.combineNotifyEmail(ctx.userid, input.notify, input.email), categoryid: question.categoryid,
        name: ctx.userid === null ? input.name : null,
      });
      await q.calcCategoryPath(postid);
      if (queued) {
        await q.queuedcountUpdate(1);
      } else {
        if (question.type === 'Q') await indexPost(q, postid, 'A', question.postid, null, input.text, null);
        await q.acountUpdateForQ(question.postid, 1);
        await q.updateHotness(question.postid, options);
        await q.acountUpdate(1);
        if (phpInt(question.acount) === 0) await q.unaqcountUpdate(-1);
        await q.updatePoints(ctx.userid, ['aposts'], options);
      }

      await reportWrite(ctx, cookie.cookieid, LIMIT.ANSWERS);
      if (!queued) await eventForQUser(q, question.postid, postid, null, ctx.userid, question.userid);
      return { id: postid, type: queued ? 'A_QUEUED' : 'A', queued, cookieid: cookie.created ? cookie.cookieid : undefined };
    });
  }

  async function createComment(request) {
    return repository.transaction(async q => {
      const ctx = await context(q, request);
      const { options } = ctx;
      const body = request.body ?? {};
      const parent = request.parentid ? await q.findPost(request.parentid, { lock: true }) : undefined;
      if (!parent || !['Q', 'A'].includes(parent.basetype)) throw new ApiError(404, 'post_not_found');
      const question = parent.basetype === 'Q' ? parent : await q.findPost(parent.parentid, { lock: true });
      checkQuestionPage(ctx, question);
      if (parent !== question && !viewable(ctx, parent)) throw new ApiError(404, 'post_not_found');
      const userlevel = userLevelForPost(parent, ctx.user);

      // qa_page_q_post_rules(): is the comment button shown for this parent?
      if (!['Q', 'A'].includes(parent.type) || permit(ctx, 'permit_post_c', userlevel) === 'level' ||
        !phpBool(options.get(parent.type === 'Q' ? 'comment_on_qs' : 'comment_on_as'))) {
        throw new ApiError(403, 'comment_not_allowed');
      }
      const limits = await q.findLimits(ctx.userid, ctx.ip, LIMIT.COMMENTS);
      const permitError = permit(ctx, 'permit_post_c', userlevel, LIMIT.COMMENTS, limits);
      if (permitError) throw new ApiError(...permitFailure(permitError, 'comment'));

      // qa_page_q_add_c_submit()
      const input = readCommon(body, options);
      const queued = moderationReason(userlevel, ctx.user, ctx.ip, options) !== false;
      const errors = filterChild(input, 'min_len_c_content', options);
      checkCaptcha(ctx, userlevel, 'captcha_on_anon_post');
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);
      const comments = (await q.findChildren(parent.postid)).filter(post => post.basetype === 'C');
      if (comments.some(comment => !Number(comment.hidden) && sameWords(comment.content, input.content))) throw new ApiError(409, 'duplicate_content');

      // qa_comment_create()
      const cookie = await postCookie(ctx);
      const postid = await q.insertPost({
        type: queued ? 'C_QUEUED' : 'C', parentid: parent.postid, userid: ctx.userid,
        cookieid: ctx.userid === null ? cookie.cookieid : null, ip: ctx.ip, title: null, content: input.content, format: input.format,
        tagstring: null, notify: text.combineNotifyEmail(ctx.userid, input.notify, input.email), categoryid: question.categoryid,
        name: ctx.userid === null ? input.name : null,
      });
      await q.calcCategoryPath(postid);
      if (queued) {
        await q.queuedcountUpdate(1);
      } else {
        if (question.type === 'Q' && ['Q', 'A'].includes(parent.type)) await indexPost(q, postid, 'C', question.postid, null, input.text, null);
        await q.updatePoints(ctx.userid, ['cposts'], options);
        await q.ccountUpdate(1);
      }

      await reportWrite(ctx, cookie.cookieid, LIMIT.COMMENTS);
      if (!queued) { // qa_event_updates, c_post: earlier commenters in the thread, then the question/parent author
        const keyuserids = new Set(comments.filter(c => c.type === 'C' && c.userid !== null).map(c => Number(c.userid)));
        for (const keyuserid of keyuserids) {
          if (keyuserid !== ctx.userid) await q.eventCreateNotEntity(keyuserid, question.postid, postid, UPDATE.FOLLOWS, ctx.userid);
        }
        const updatetype = parent.basetype === 'Q' ? UPDATE.C_FOR_Q : UPDATE.C_FOR_A;
        const parentUser = parent.userid === null || keyuserids.has(Number(parent.userid)) ? null : parent.userid;
        await eventForQUser(q, question.postid, postid, updatetype, ctx.userid, parentUser);
      }
      return { id: postid, type: queued ? 'C_QUEUED' : 'C', queued, cookieid: cookie.created ? cookie.cookieid : undefined };
    });
  }

  return { createQuestion, createAnswer, createComment };
}
module.exports = { createPostService };
