// Pieces shared by the posting services (creating posts and changing them): request input,
// the basic filter module's rules, and helpers for permissions, visibility, the word index,
// update streams and the qa_event_limits bookkeeping.
const { ApiError } = require('../errors');
const { phpBool, phpInt, phpNum } = require('../q2a/php');
const {
  LEVEL, LIMIT, userPermitError, userLevelForPost, userLevelForCategories, userLevelMaximum, moderationReason, postIsByUser,
} = require('../q2a/permissions');
const text = require('../q2a/text');

const MAX = { TITLE: 800, CONTENT: 12000, TAGS: 800, EMAIL: 80 }; // qa-include/db/maxima.php
// QA_UPDATE_* (app/updates.php)
const UPDATE = { CATEGORY: 'A', CLOSED: 'C', CONTENT: 'E', PARENT: 'M', SELECTED: 'S', TAGS: 'T', TYPE: 'Y', VISIBLE: 'H', FOLLOWS: 'F', C_FOR_Q: 'U', C_FOR_A: 'N' };

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
// The basic filter checks only the fields present (an edit form may show some of them).
function filterQuestion(input, options) {
  const errors = {};
  const qmin = phpNum(options.get('min_len_q_title'));
  if ('title' in input) validateLength(errors, 'title', input.title, qmin, Math.max(qmin, Math.min(phpNum(options.get('max_len_q_title')), MAX.TITLE)));
  if ('content' in input) validateLength(errors, 'content', input.content, 0, MAX.CONTENT);
  if ('text' in input) validateLength(errors, 'text', input.text, phpNum(options.get('min_len_q_content')), null);
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
  if ('content' in input) validateLength(errors, 'content', input.content, 0, MAX.CONTENT);
  if ('text' in input) validateLength(errors, 'text', input.text, phpNum(options.get(minOption)), null, 'content');
  validatePostEmail(errors, input);
  return errors;
}
const sameWords = (a, b) => text.stringToWords(a).join(' ') === text.stringToWords(b).join(' ');

function createPostHelpers({ identify }) {
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

  // qa_search_basic::unindex_post()
  async function unindexPost(q, postid) {
    for (const [table, column] of [['qa_titlewords', 'titlecount'], ['qa_contentwords', 'contentcount'], ['qa_tagwords', 'tagwordcount'], ['qa_posttags', 'tagcount']]) {
      const wordids = await q.indexedWordIds(table, postid);
      await q.deleteIndexed(table, postid);
      await q.updateWordCounts(column, table, wordids);
    }
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


  // qa_page_q_post_rules(): which buttons the page shows the user for $post, and which work immediately.
  function postRules(ctx, post, parentpost = null, siblingposts = null, childposts = null) {
    const { options, userid, cookieid } = ctx;
    const o = name => phpBool(options.get(name));
    const userlevel = userLevelForPost(post, ctx.user);
    const pe = permitoption => permit(ctx, permitoption, userlevel);
    const hidden = Boolean(Number(post.hidden));
    const queued = Boolean(Number(post.queued));
    const r = {};
    r.isbyuser = postIsByUser(post, userid, cookieid);
    r.closed = post.basetype === 'Q' && (post.closedbyid !== null || (post.selchildid !== null && o('do_close_on_select')));
    const postQ = pe('permit_post_q');
    const postA = pe('permit_post_a');
    const postC = pe('permit_post_c');
    const edit = pe(post.basetype === 'Q' ? 'permit_edit_q' : post.basetype === 'A' ? 'permit_edit_a' : 'permit_edit_c');
    const retagcat = pe('permit_retag_cat');
    const hideShow = pe('permit_hide_show');
    const hideShowSelf = r.isbyuser ? pe(null) : hideShow;
    const closeOpen = pe(r.isbyuser && o('allow_close_own_questions') ? null : 'permit_close_q');
    const moderate = pe('permit_moderate');
    r.authorlast = post.lastuserid === null || String(post.lastuserid) === String(post.userid);
    r.viewable = hidden ? !hideShowSelf : (queued ? (r.isbyuser || !moderate) : true);
    r.answerbutton = post.type === 'Q' && postA !== 'level' && !r.closed && (o('allow_self_answer') || !r.isbyuser);
    r.commentbutton = ['Q', 'A'].includes(post.type) && postC !== 'level' && o(post.type === 'Q' ? 'comment_on_qs' : 'comment_on_as');
    r.commentable = r.commentbutton && !postC;
    const buttonErrors = ['login', 'level', 'approve'];
    r.editbutton = !hidden && !r.closed && (r.isbyuser || (!buttonErrors.includes(edit) && !queued));
    r.editable = r.editbutton && (r.isbyuser || !edit);
    const usingTags = String(options.get('tags_or_categories')).includes('t');
    const usingCategories = String(options.get('tags_or_categories')).includes('c');
    r.retagcatbutton = post.basetype === 'Q' && (usingTags || usingCategories) && !hidden && (r.isbyuser || !buttonErrors.includes(retagcat));
    r.retagcatable = r.retagcatbutton && (r.isbyuser || !retagcat);
    if (r.editbutton && r.retagcatbutton) {
      if (r.retagcatable && !r.editable) r.editbutton = false;
      else r.retagcatbutton = false;
    }
    r.aselectable = post.type === 'Q' && !pe(r.isbyuser ? null : 'permit_select_a');
    const notclosedbyother = !(r.closed && post.closedbyid !== null && !r.authorlast);
    const nothiddenbyother = !(hidden && !r.authorlast);
    r.closeable = o('allow_close_questions') && post.type === 'Q' && !r.closed && closeOpen === false;
    r.reopenable = r.closed && closeOpen === false && !hidden && (notclosedbyother || !pe('permit_close_q'));
    r.moderatable = queued && !moderate;
    r.hideable = !hidden && (r.isbyuser || !queued) && !hideShowSelf && (notclosedbyother || !hideShow);
    r.reshowimmed = hidden && !hideShow;
    r.reshowable = hidden && !hideShowSelf && (r.reshowimmed || (nothiddenbyother && !Number(post.flagcount)));
    r.deleteable = hidden && !pe('permit_delete_hidden');
    r.claimable = post.userid === null && userid !== null && post.cookieid !== null && String(post.cookieid) === String(cookieid) &&
      !(post.basetype === 'Q' ? postQ : post.basetype === 'A' ? postA : postC);
    if (r.claimable && post.basetype === 'A') {
      if (!o('allow_self_answer') && parentpost && postIsByUser(parentpost, userid, cookieid)) r.claimable = false;
      if (siblingposts && !o('allow_multi_answers') && siblingposts.some(s => String(s.parentid) === String(post.parentid) && s.basetype === 'A' && postIsByUser(s, userid, cookieid))) {
        r.claimable = false;
      }
    }
    for (const child of childposts ?? []) {
      if (String(child.parentid) !== String(post.postid)) continue;
      r.deleteable = false;
      if (child.basetype === 'A' && postIsByUser(child, userid, cookieid)) {
        if (!o('allow_multi_answers')) r.answerbutton = false;
        if (!o('allow_self_answer')) r.claimable = false;
      }
    }
    r.userlevel = userlevel;
    return r;
  }

  // qa_page_q_permit_edit(): the permission switch run before an edit form is saved.
  function permitEdit(ctx, post, rules, permitoption, permitoption2 = null) {
    let error = permit(ctx, rules.isbyuser ? null : permitoption, rules.userlevel);
    if (error && permitoption2) {
      const error2 = permit(ctx, rules.isbyuser ? null : permitoption2, rules.userlevel);
      if (error === 'level' || error === 'approve' || !error2) error = error2;
    }
    if (!error) return;
    if (error === 'login') throw new ApiError(401, 'unauthenticated');
    if (error === 'confirm') throw new ApiError(403, 'edit_must_confirm');
    throw new ApiError(403, 'no_permission');
  }

  // qa_question_set_selchildid(). Hiding or converting a selected answer calls it with no user (actor null).
  async function setSelchildid(ctx, oldquestion, selchildid, answers, actor = { userid: ctx.userid, cookieid: ctx.cookieid }) {
    const { q, options } = ctx;
    const userid = actor ? actor.userid : null;
    const ip = ctx.ip;
    const byId = new Map(answers.map(answer => [Number(answer.postid), answer]));
    const oldselchildid = oldquestion.selchildid === null ? null : Number(oldquestion.selchildid);
    const closed = oldquestion.closedbyid !== null || (oldquestion.selchildid !== null && phpBool(options.get('do_close_on_select')));
    const report = () => (actor ? reportAction({ ...ctx, userid, cookieid: actor.cookieid }, null) : undefined);
    const closeEdit = { userid, ip }; // qa_db_post_set_closed() records the edit when the IP is known
    await q.setSelchildid(oldquestion.postid, selchildid, userid !== null ? { userid, ip } : null);
    await q.updatePoints(oldquestion.userid, ['aselects'], options);
    if (oldselchildid !== null && byId.has(oldselchildid)) {
      await q.unselqcountUpdate(1);
      await q.updatePoints(byId.get(oldselchildid).userid, ['aselecteds'], options);
      await report(); // a_unselect
      if (closed && oldquestion.closedbyid === null) {
        await q.setClosed(oldquestion.postid, null, closeEdit);
        await report(); // q_reopen
        await eventForQUser(q, oldquestion.postid, oldquestion.postid, UPDATE.CLOSED, userid, oldquestion.userid);
      }
    }
    if (selchildid !== null) {
      await q.unselqcountUpdate(-1);
      await q.updatePoints(byId.get(selchildid).userid, ['aselecteds'], options);
      await report(); // a_select
      await eventForQUser(q, oldquestion.postid, selchildid, UPDATE.SELECTED, userid, byId.get(selchildid).userid);
      if (!closed && phpBool(options.get('do_close_on_select'))) {
        await q.setClosed(oldquestion.postid, null, closeEdit);
        await report(); // q_close
        await eventForQUser(q, oldquestion.postid, oldquestion.postid, UPDATE.CLOSED, userid, oldquestion.userid);
      }
    }
  }

  // qa_event_limits for other write events: record the last write (and count it when limitAction is given).
  async function reportAction(ctx, limitAction) {
    if (limitAction) await ctx.q.incrementLimits(ctx.userid, ctx.ip, limitAction, ctx.period);
    if (ctx.userid !== null) await ctx.q.userWritten(ctx.userid, ctx.ip);
    else if (ctx.cookieid) await ctx.q.cookieWritten(ctx.cookieid, ctx.ip);
  }

  return { context, permit, postCookie, viewable, checkQuestionPage, indexPost, unindexPost, eventForQUser, reportWrite, checkCaptcha, postRules, permitEdit, setSelchildid, reportAction };
}

module.exports = {
  MAX, UPDATE, permitFailure, stringField, readContent, readCommon, readId, validateLength, validatePostEmail,
  filterQuestion, filterChild, sameWords, createPostHelpers,
};
