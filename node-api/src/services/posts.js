// Creating questions, answers and comments. Ports, in PHP's order:
// - checks from pages/ask.php, pages/question-post.php (answer/comment permission switch),
//   pages/question-submit.php (qa_page_q_add_a_submit / qa_page_q_add_c_submit) and the
//   button rules of qa_page_q_post_rules() in pages/question-view.php;
// - input rules of the basic filter module (plugins/qa-filter-basic.php);
// - qa_question_create(), qa_answer_create(), qa_comment_create() (app/post-create.php);
// - the built-in modules those trigger: qa_search_basic (word index), qa_event_limits and qa_event_updates.
const { ApiError } = require('../errors');
const { phpBool, phpInt, phpNum } = require('../q2a/php');
const {
  LEVEL, LIMIT, userPermitError, userLevelForPost, userLevelForCategories, userLevelMaximum, moderationReason, postIsByUser,
} = require('../q2a/permissions');
const text = require('../q2a/text');

const MAX = { TITLE: 800, CONTENT: 12000, TAGS: 800, EMAIL: 80 }; // qa-include/db/maxima.php
const UPDATE = { FOLLOWS: 'F', C_FOR_Q: 'U', C_FOR_A: 'N' }; // app/updates.php

// Permission errors reported by the pages; 'level' and anything else becomes no_permission.
function permitFailure(error, kind) {
  switch (error) {
    case 'login': return [401, 'unauthenticated'];
    case 'confirm': return [403, `${kind}_must_confirm`];
    case 'approve': return [403, `${kind}_must_be_approved`];
    case 'limit': return [429, `${kind}_limit`];
    default: return [403, 'no_permission'];
  }
}

// --- request input (the bridge sends what Q2A's editor and form fields produced) ---
function stringField(body, name) {
  const value = body[name];
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, 'invalid_input', { [name]: 'invalid' });
  return text.postText(value);
}
function readContent(body) {
  const format = body.format ?? '';
  if (format !== '' && format !== 'html') throw new ApiError(400, 'invalid_input', { format: 'invalid' });
  const content = text.removeUtf8mb4(stringField(body, 'content') ?? '');
  return { content, format, text: text.removeUtf8mb4(text.viewerText(content, format)) };
}
function readCommon(body, options) {
  if (body.notify !== undefined && typeof body.notify !== 'boolean') throw new ApiError(400, 'invalid_input', { notify: 'invalid' });
  return {
    ...readContent(body),
    notify: body.notify === true,
    email: stringField(body, 'email'),
    name: phpBool(options.get('allow_anonymous_naming')) ? stringField(body, 'name') : null,
  };
}
function readId(value, name) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) throw new ApiError(400, 'invalid_input', { [name]: 'invalid' });
  return value;
}

// --- qa_filter_basic ---
function validateLength(errors, key, value, min, max, errorKey = key) {
  const length = text.strlen(value);
  if (length < min) errors[errorKey] = min === 1 ? 'required' : 'min_length';
  else if (max !== null && length > max) errors[errorKey] = 'max_length';
}
function validatePostEmail(errors, input) {
  if (input.notify && input.email) {
    if (!text.emailValidate(input.email)) errors.email = 'invalid';
    else if (text.strlen(input.email) > MAX.EMAIL) errors.email = 'max_length';
  }
}
function filterQuestion(input, options) {
  const errors = {};
  const qmin = phpNum(options.get('min_len_q_title'));
  validateLength(errors, 'title', input.title, qmin, Math.max(qmin, Math.min(phpNum(options.get('max_len_q_title')), MAX.TITLE)));
  validateLength(errors, 'content', input.content, 0, MAX.CONTENT);
  validateLength(errors, 'text', input.text, phpNum(options.get('min_len_q_content')), null);
  if (errors.text) { errors.content = errors.text; delete errors.text; }
  if (input.tags) {
    const maxtags = phpNum(options.get('max_num_q_tags'));
    const mintags = Math.min(phpNum(options.get('min_num_q_tags')), maxtags);
    if (input.tags.length < mintags) errors.tags = 'min_tags';
    else if (input.tags.length > maxtags) errors.tags = 'max_tags';
    else if (text.strlen(text.tagsToTagstring(input.tags)) > MAX.TAGS) errors.tags = 'max_length';
  }
  validatePostEmail(errors, input);
  return errors;
}
function filterChild(input, minOption, options) {
  const errors = {};
  validateLength(errors, 'content', input.content, 0, MAX.CONTENT);
  validateLength(errors, 'text', input.text, phpNum(options.get(minOption)), null, 'content');
  validatePostEmail(errors, input);
  return errors;
}

const sameWords = (a, b) => text.stringToWords(a).join(' ') === text.stringToWords(b).join(' ');

function createPostService(repository, { identify }) {
  // Loads what every operation needs; Q2A reads all of this per request too.
  async function context(q, { token, cookieid, ip }) {
    const options = await q.loadOptions();
    q.setMaxStoreUserUpdates(options.get('max_store_user_updates'));
    const identity = await identify(token);
    const user = identity ? await q.findActor(identity.id) : null;
    return { q, options, user, userid: user ? Number(user.userid) : null, cookieid: cookieid ?? null, ip, period: Math.trunc(options.dbTime / 3600) };
  }
  const permit = (ctx, permitoption, userlevel, limitAction, limits) =>
    userPermitError({ permitoption, limitAction, userlevel, user: ctx.user, ip: ctx.ip, options: ctx.options, limits });

  // qa_cookie_get_create(): anonymous posts are tied to the visitor's qa_id cookie.
  async function postCookie(ctx) {
    if (ctx.userid !== null) return { cookieid: ctx.cookieid, created: false };
    if (ctx.cookieid && /^\d{1,20}$/.test(ctx.cookieid) && await ctx.q.cookieExists(ctx.cookieid)) return { cookieid: ctx.cookieid, created: false };
    return { cookieid: await ctx.q.createCookie(ctx.ip), created: true };
  }

  // qa_page_q_post_rules()['viewable'] for the question or parent being posted to.
  function viewable(ctx, post) {
    const userlevel = userLevelForPost(post, ctx.user);
    const isbyuser = postIsByUser(post, ctx.userid, ctx.cookieid);
    if (Number(post.hidden)) return !permit(ctx, isbyuser ? null : 'permit_hide_show', userlevel);
    if (Number(post.queued)) return isbyuser || !permit(ctx, 'permit_moderate', userlevel);
    return true;
  }
  // The question page refuses to show anything for a missing, non-question or unviewable post.
  function checkQuestionPage(ctx, question) {
    if (!question || question.basetype !== 'Q') throw new ApiError(404, 'question_not_found');
    if (!viewable(ctx, question)) throw new ApiError(403, 'question_not_viewable');
    if (permit(ctx, 'permit_view_q_page', userLevelForPost(question, ctx.user))) throw new ApiError(403, 'no_permission');
  }

  // qa_search_basic::index_post()
  async function indexPost(q, postid, type, questionid, title, postText, tagstring) {
    const unique = values => [...new Set(values)];
    const titlewords = unique(text.stringToWords(title ?? ''));
    const contentcount = new Map();
    for (const word of text.stringToWords(postText)) contentcount.set(word, (contentcount.get(word) ?? 0) + 1);
    const tagwords = unique(text.stringToWords(tagstring ?? ''));
    const wholetags = unique(text.tagstringToTags(tagstring));
    const wordtoid = await q.wordMapToIdsAdd(unique([...titlewords, ...contentcount.keys(), ...tagwords, ...wholetags]));
    const ids = words => words.filter(word => wordtoid.has(word)).map(word => wordtoid.get(word));
    const titlewordids = ids(titlewords);
    const contentwordidcounts = [...contentcount].filter(([word]) => wordtoid.has(word)).map(([word, count]) => [wordtoid.get(word), count]);
    const tagwordids = ids(tagwords);
    const wholetagids = ids(wholetags);
    await q.addTitleWords(postid, titlewordids);
    await q.addContentWords(postid, type, questionid, contentwordidcounts);
    await q.addTagWords(postid, tagwordids);
    await q.addPostTags(postid, wholetagids);
    await q.updateWordCounts('titlecount', 'qa_titlewords', titlewordids);
    await q.updateWordCounts('contentcount', 'qa_contentwords', contentwordidcounts.map(([id]) => id));
    await q.updateWordCounts('tagwordcount', 'qa_tagwords', tagwordids);
    await q.updateWordCounts('tagcount', 'qa_posttags', wholetagids);
  }

  // qa_create_event_for_q_user()
  async function eventForQUser(q, questionid, lastpostid, updatetype, lastuserid, otheruserid = null) {
    await q.eventCreateForEntity('Q', questionid, questionid, lastpostid, updatetype, lastuserid);
    if (lastuserid !== null) await q.eventCreateForEntity('U', lastuserid, questionid, lastpostid, updatetype, lastuserid);
    if (otheruserid !== null && otheruserid !== undefined && Number(otheruserid) !== Number(lastuserid)) {
      await q.eventCreateNotEntity(otheruserid, questionid, lastpostid, updatetype, lastuserid);
    }
  }

  // qa_event_limits for *_post and *_queue events: count the action and record the last write.
  async function reportWrite(ctx, cookieid, limitAction) {
    await ctx.q.incrementLimits(ctx.userid, ctx.ip, limitAction, ctx.period);
    if (ctx.userid !== null) await ctx.q.userWritten(ctx.userid, ctx.ip);
    else if (cookieid) await ctx.q.cookieWritten(cookieid, ctx.ip);
  }

  // qa_captcha_validate_post() only runs when a captcha module is available, which needs keys.
  function captchaAvailable(options) {
    return phpBool(options.get('captcha_module')) && phpBool(options.get('recaptcha_public_key')) && phpBool(options.get('recaptcha_private_key'));
  }
  function checkCaptcha(ctx, userlevel, anonymousOption) {
    // qa_user_captcha_reason()
    if (!captchaAvailable(ctx.options) || ctx.user && Number(ctx.user.level) >= LEVEL.APPROVED) return;
    const o = name => phpBool(ctx.options.get(name));
    const level = userlevel ?? ctx.user?.level ?? 0;
    if (Number(level) >= LEVEL.APPROVED) return;
    const reason = (o(anonymousOption) && ctx.userid === null) || (o('moderate_users') && o('captcha_on_unapproved')) ||
      (o('confirm_user_emails') && o('captcha_on_unconfirmed') && !(Number(ctx.user?.flags) & 1));
    if (reason) throw new ApiError(400, 'captcha_required');
  }

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
