// Changing existing posts. Ports, in PHP's order, the page handlers in pages/question-post.php
// (qa_page_q_edit_q_submit, qa_page_q_edit_a_submit, qa_page_q_edit_c_submit and the permission
// switch in qa_page_q_permit_edit) and the functions they call in app/post-update.php, plus the
// built-in event modules those report to (qa_event_limits, qa_event_updates).
const { ApiError } = require('../errors');
const { phpBool } = require('../q2a/php');
const { LIMIT, limitsRemaining, userLevelForPost, userLevelForCategories, moderationReason } = require('../q2a/permissions');
const text = require('../q2a/text');
const notify = require('../q2a/notify');
const { UPDATE, stringField, readContent, filterQuestion, filterChild, createPostHelpers } = require('./post-common');

const STATUS = { NORMAL: 0, HIDDEN: 1, QUEUED: 2 }; // QA_POST_STATUS_*

const ANSWER_TYPES = ['A', 'A_HIDDEN', 'A_QUEUED'];

function createPostChangeService(repository, { identify }) {
  const helpers = createPostHelpers({ identify });
  const { withIdentity, context, permit, checkQuestionPage, indexPost, unindexPost, eventForQUser, postRules, permitEdit, setSelchildid, reportAction } = helpers;

  // Everything the question page loads for the question that contains $post.
  async function questionPage(ctx, post) {
    const { q } = ctx;
    let parent = null;
    let question = post;
    if (post.basetype === 'A') question = await q.findPost(post.parentid, { lock: true });
    if (post.basetype === 'C') {
      parent = await q.findPost(post.parentid, { lock: true });
      question = parent?.basetype === 'Q' ? parent : parent ? await q.findPost(parent.parentid, { lock: true }) : null;
    }
    checkQuestionPage(ctx, question);
    const children = await q.findChildren(question.postid);
    const answers = children.filter(child => ANSWER_TYPES.includes(child.type));
    const achildren = [];
    for (const answer of answers) achildren.push(...await q.findChildren(answer.postid));
    // qa_page_q_load_c_follows(): comments and follow-on questions on the question and its answers.
    const commentsfollows = [...children, ...achildren].filter(child => ['Q', 'C'].includes(child.basetype));
    const closepost = question.closedbyid !== null ? await q.findPost(question.closedbyid) : null;
    // pages/question.php gives the question's rules its children and its duplicates ($childposts + $duplicateposts).
    const qchildren = [...children, ...await q.findDuplicates(question.postid)];
    return { question, parent, children, qchildren, answers, achildren, commentsfollows, closepost };
  }

  // qa_private_question_basic_cache_recalc()
  async function questionBasicCacheRecalc(q, question, difference) {
    if (Number(question.acount) === 0) await q.unaqcountUpdate(difference);
    if (Number(question.amaxvote) === 0) await q.unupaqcountUpdate(difference);
    if (question.selchildid === null) await q.unselqcountUpdate(difference);
  }
  // qa_private_question_cache_recalc()
  async function questionCacheRecalc(q, question, difference) {
    await q.pathQcountUpdate(await q.getCategoryPath(question.postid));
    await q.qcountUpdate(difference);
    if (question.closedbyid === null) await questionBasicCacheRecalc(q, question, difference);
    await q.tagcountUpdate();
  }
  // qa_private_disable_answer_recalc()
  async function disableAnswerRecalc(ctx, question, netvotes) {
    const { q, options } = ctx;
    await q.updateHotness(question.postid, options);
    await q.acountUpdate(-1);
    await q.acountUpdateForQ(question.postid, -1);
    const onlyAnswer = Number(question.acount) === 1;
    const open = question.closedbyid === null;
    if (onlyAnswer && open) await q.unaqcountUpdate(1);
    if (Number(question.amaxvote) > 0 && Number(question.amaxvote) === Number(netvotes)) {
      if (onlyAnswer) {
        await q.amaxvoteUpdateForQ(question.postid, 0, false);
        if (open) await q.unupaqcountUpdate(1);
      } else {
        const changed = await q.amaxvoteUpdateForQ(question.postid);
        if (changed > 0 && open && await q.questionAmaxvote(question.postid) === 0) await q.unupaqcountUpdate(1);
      }
    }
  }
  const flaggedChange = async (q, post, difference) => {
    if (Number(post.flagcount) > 0) await q.flaggedcountUpdate(difference * Number(post.flagcount));
  };
  const editRecord = (ctx, updatetype) => ({ updatetype, userid: ctx.userid, ip: ctx.ip });

  // qa_create_event_for_tags() and qa_create_event_for_category()
  async function eventsForTags(q, tagstring, questionid, updatetype, userid) {
    for (const wordid of (await q.wordMapToIds([...new Set(text.tagstringToTags(tagstring))])).values()) {
      await q.eventCreateForEntity('T', wordid, questionid, questionid, updatetype, userid);
    }
  }
  async function eventsForCategory(q, categoryid, questionid, updatetype, userid) {
    if (categoryid === null) return;
    for (const category of await q.categoryPath(categoryid)) await q.eventCreateForEntity('C', category.categoryid, questionid, questionid, updatetype, userid);
  }

  // qa_question_set_content()
  async function questionSetContent(ctx, page, old, input, remoderate, silent) {
    const { q, options } = ctx;
    await unindexPost(q, old.postid);
    const wasqueued = old.type === 'Q_QUEUED';
    const titlechanged = (old.title ?? '') !== input.title;
    const contentchanged = old.content !== input.content || old.format !== input.format;
    const tagschanged = (old.tags ?? '') !== input.tagstring;
    const setupdated = (titlechanged || contentchanged || tagschanged) && !wasqueued && !silent;
    await q.setContent(old.postid, input, setupdated ? editRecord(ctx, titlechanged || contentchanged ? UPDATE.CONTENT : UPDATE.TAGS) : null);
    if (input.extra !== undefined && input.extra !== null) await q.setPostMeta(old.postid, 'qa_q_extra', input.extra);
    if (setupdated && remoderate) {
      for (const answer of page.answers) await unindexPost(q, answer.postid);
      for (const comment of page.commentsfollows) if (comment.basetype === 'C') await unindexPost(q, comment.postid);
      if (page.closepost && String(page.closepost.parentid) === String(old.postid)) await unindexPost(q, page.closepost.postid);
      await q.setType(old.postid, 'Q_QUEUED', null);
      await questionCacheRecalc(q, old, -1);
      await q.queuedcountUpdate(1);
      await q.updatePoints(old.userid, ['qposts', 'aselects'], options);
      await flaggedChange(q, old, -1);
      await notify.queued(q, options, { basetype: 'Q', requeue: true, handle: ctx.user?.handle ?? null, name: input.name ?? old.name, postid: old.postid, title: input.title, text: input.text }); // q_requeue
    } else if (old.type === 'Q') {
      await indexPost(q, old.postid, 'Q', old.postid, input.title, input.text, input.tagstring);
      if (tagschanged) await q.tagcountUpdate();
    }
    await reportAction(ctx, null); // q_edit
    if (!silent) {
      const updatetype = titlechanged || contentchanged ? UPDATE.CONTENT : tagschanged ? UPDATE.TAGS : null;
      if (updatetype) {
        await eventForQUser(q, old.postid, old.postid, updatetype, ctx.userid, old.userid);
        if (tagschanged) await eventsForTags(q, input.tagstring, old.postid, UPDATE.TAGS, ctx.userid);
      }
    }
    return setupdated && remoderate ? 'Q_QUEUED' : old.type;
  }

  // qa_question_set_category()
  async function questionSetCategory(ctx, page, old, categoryid, silent) {
    const { q } = ctx;
    const oldpath = await q.getCategoryPath(old.postid);
    await q.setCategory(old.postid, categoryid, silent ? null : { userid: ctx.userid, ip: ctx.ip });
    await q.calcCategoryPath(old.postid);
    const newpath = await q.getCategoryPath(old.postid);
    await q.pathQcountUpdate(oldpath);
    await q.pathQcountUpdate(newpath);
    const others = page.answers.map(a => a.postid).concat(page.commentsfollows.filter(c => c.basetype === 'C').map(c => c.postid));
    if (page.closepost && String(page.closepost.parentid) === String(old.postid)) others.push(page.closepost.postid);
    await q.setPostsCategoryPath(others, newpath);
    await reportAction(ctx, null); // q_move (the built-in search module ignores categories)
    await eventForQUser(q, old.postid, old.postid, UPDATE.CATEGORY, ctx.userid, old.userid);
    await eventsForCategory(q, categoryid, old.postid, UPDATE.CATEGORY, ctx.userid);
  }

  // qa_answer_set_content()
  async function answerSetContent(ctx, page, old, input, remoderate, silent) {
    const { q, options } = ctx;
    const { question } = page;
    await unindexPost(q, old.postid);
    const wasqueued = old.type === 'A_QUEUED';
    const contentchanged = old.content !== input.content || old.format !== input.format;
    const setupdated = contentchanged && !wasqueued && !silent;
    await q.setContent(old.postid, { ...input, title: old.title, tagstring: old.tags }, setupdated ? editRecord(ctx, UPDATE.CONTENT) : null);
    if (setupdated && remoderate) {
      for (const comment of page.achildren) {
        if (comment.basetype === 'C' && String(comment.parentid) === String(old.postid)) await unindexPost(q, comment.postid);
      }
      await q.setType(old.postid, 'A_QUEUED', null);
      await disableAnswerRecalc(ctx, question, old.netvotes);
      await q.queuedcountUpdate(1);
      await q.updatePoints(old.userid, ['aposts', 'aselecteds'], options);
      await flaggedChange(q, old, -1);
      await notify.queued(q, options, { basetype: 'A', requeue: true, handle: ctx.user?.handle ?? null, name: input.name ?? old.name, postid: old.postid, text: input.text, question }); // a_requeue
    } else if (old.type === 'A' && question.type === 'Q') {
      await indexPost(q, old.postid, 'A', question.postid, null, input.text, null);
    }
    await reportAction(ctx, null); // a_edit
    if (!silent && contentchanged) await eventForQUser(q, old.parentid, old.postid, UPDATE.CONTENT, ctx.userid, old.userid);
    return setupdated && remoderate ? 'A_QUEUED' : old.type;
  }

  // qa_answer_to_comment()
  async function answerToComment(ctx, page, old, parentid, input, remoderate, silent) {
    const { q, options } = ctx;
    const { question, answers } = page;
    const parent = answers.find(a => Number(a.postid) === Number(parentid)) ?? question;
    await unindexPost(q, old.postid);
    const wasqueued = old.type === 'A_QUEUED';
    const contentchanged = old.content !== input.content || old.format !== input.format;
    const setupdated = contentchanged && !wasqueued && !silent;
    const newtype = setupdated && remoderate ? 'C_QUEUED' : `C${old.type.slice(1)}`;
    await q.setType(old.postid, newtype, wasqueued || silent ? null : editRecord(ctx, UPDATE.TYPE));
    await q.setParent(old.postid, parentid);
    await q.setContent(old.postid, { ...input, title: old.title, tagstring: old.tags }, setupdated ? editRecord(ctx, UPDATE.CONTENT) : null);
    for (const follow of page.commentsfollows) {
      if (String(follow.parentid) === String(old.postid)) await q.setParent(follow.postid, parentid);
    }
    if (old.type === 'A') await disableAnswerRecalc(ctx, question, old.netvotes);
    if (newtype === 'C') await q.ccountUpdate(1);
    if (wasqueued) { if (newtype !== 'C_QUEUED') await q.queuedcountUpdate(-1); } else if (newtype === 'C_QUEUED') await q.queuedcountUpdate(1);
    await q.updatePoints(old.userid, ['aposts', 'aselecteds', 'cposts', 'avoteds', 'cvoteds'], options);
    for (const { userid, vote } of await q.postUserVotes(old.postid)) await q.updatePoints(userid, [vote > 0 ? 'aupvotes' : 'adownvotes'], options);
    if (setupdated && remoderate) {
      await flaggedChange(q, old, -1);
      await notify.queued(q, options, { basetype: 'C', requeue: true, handle: ctx.user?.handle ?? null, name: input.name ?? old.name, postid: old.postid, text: input.text, question }); // c_requeue
    } else if (old.type === 'A' && question.type === 'Q' && ['Q', 'A'].includes(parent.type)) {
      await indexPost(q, old.postid, 'C', question.postid, null, input.text, null);
    }
    if (question.selchildid !== null && Number(question.selchildid) === Number(old.postid)) await setSelchildid(ctx, question, null, [old], null);
    await reportAction(ctx, LIMIT.COMMENTS); // a_to_c counts as a comment
    if (!silent) await eventForQUser(q, question.postid, old.postid, contentchanged ? UPDATE.CONTENT : UPDATE.TYPE, ctx.userid, old.userid);
    return newtype;
  }

  // qa_comment_set_content()
  async function commentSetContent(ctx, page, old, input, remoderate, silent) {
    const { q, options } = ctx;
    const { question, parent } = page;
    await unindexPost(q, old.postid);
    const wasqueued = old.type === 'C_QUEUED';
    const contentchanged = old.content !== input.content || old.format !== input.format;
    const setupdated = contentchanged && !wasqueued && !silent;
    await q.setContent(old.postid, { ...input, title: old.title, tagstring: old.tags }, setupdated ? editRecord(ctx, UPDATE.CONTENT) : null);
    if (setupdated && remoderate) {
      await q.setType(old.postid, 'C_QUEUED', null);
      if (old.type === 'C') await q.ccountUpdate(-1);
      await q.queuedcountUpdate(1);
      await q.updatePoints(old.userid, ['cposts'], options);
      await flaggedChange(q, old, -1);
      await notify.queued(q, options, { basetype: 'C', requeue: true, handle: ctx.user?.handle ?? null, name: input.name ?? old.name, postid: old.postid, text: input.text, question }); // c_requeue
    } else if (old.type === 'C' && question.type === 'Q' && ['Q', 'A'].includes(parent.type)) {
      await indexPost(q, old.postid, 'C', question.postid, null, input.text, null);
    }
    await reportAction(ctx, null); // c_edit
    if (!silent && contentchanged) await eventForQUser(q, question.postid, old.postid, UPDATE.CONTENT, ctx.userid, old.userid);
    return setupdated && remoderate ? 'C_QUEUED' : old.type;
  }

  // --- input shared by the three edit forms ---
  // Fields left out keep their current values (the PHP form always sends every displayed field).
  function readEditContent(body, old) {
    if (body.content === undefined) return {};
    const read = readContent({ ...body, format: body.format ?? old.format });
    return { content: read.content, format: read.format, text: read.text };
  }
  function readAuthorFields(ctx, body, rules) {
    const input = {};
    if (!rules.isbyuser) return input;
    if (phpBool(ctx.options.get('allow_anonymous_naming')) && body.name !== undefined) input.name = stringField(body, 'name');
    if (body.notify !== undefined) {
      if (typeof body.notify !== 'boolean') throw new ApiError(400, 'invalid_input', { notify: 'invalid' });
      input.notify = body.notify;
      input.email = stringField(body, 'email');
    }
    return input;
  }
  function readSilent(ctx, body, post) {
    return !permit(ctx, 'permit_edit_silent', userLevelForPost(post, ctx.user)) && body.silent === true;
  }
  const setNotify = (old, rules, input) => (rules.isbyuser && input.notify !== undefined ? text.combineNotifyEmail(old.userid, input.notify, input.email) : old.notify);
  const fail = errors => { if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors); };
  const remoderation = (ctx, userlevel) => phpBool(ctx.options.get('moderate_edited_again')) && moderationReason(userlevel, ctx.user, ctx.ip, ctx.options) !== false;

  // qa_page_q_edit_q_submit()
  async function editQuestion(ctx, page, body) {
    const { q, options } = ctx;
    const question = page.question;
    const rules = postRules(ctx, question, null, null, page.qchildren);
    if (!rules.editbutton && !rules.retagcatbutton) throw new ApiError(403, 'edit_not_allowed');
    permitEdit(ctx, question, rules, 'permit_edit_q', 'permit_retag_cat');

    const input = {};
    if (rules.editable) {
      if (body.title !== undefined) input.title = text.removeUtf8mb4(stringField(body, 'title') ?? '');
      Object.assign(input, readEditContent(body, question));
      if (phpBool(options.get('extra_field_active')) && body.extra !== undefined) input.extra = stringField(body, 'extra');
    }
    let path = null;
    if (rules.retagcatable) {
      if (String(options.get('tags_or_categories')).includes('t') && body.tags !== undefined) {
        const tags = Array.isArray(body.tags) ? body.tags.join(phpBool(options.get('tag_separator_comma')) ? ',' : ' ') : body.tags;
        if (tags !== null && typeof tags !== 'string') throw new ApiError(400, 'invalid_input', { tags: 'invalid' });
        input.tags = text.tagsFromInput(tags, phpBool(options.get('tag_separator_comma')));
      }
      if (String(options.get('tags_or_categories')).includes('c') && body.categoryid !== undefined) {
        if (body.categoryid !== null && !Number.isInteger(body.categoryid)) throw new ApiError(400, 'invalid_input', { categoryid: 'invalid' });
        path = body.categoryid === null ? [] : await q.categoryPath(body.categoryid);
        if (body.categoryid !== null && !path.length) throw new ApiError(400, 'invalid_input', { categoryid: 'invalid' });
        input.categoryid = body.categoryid;
      }
    }
    const userlevel = path ? userLevelForCategories(path.map(row => row.categoryid), ctx.user) : null;
    Object.assign(input, readAuthorFields(ctx, body, rules));
    const silent = readSilent(ctx, body, question);
    const remoderate = remoderation(ctx, userlevel);

    const errors = filterQuestion(input, options);
    if ('categoryid' in input && String(input.categoryid ?? '') !== String(question.categoryid ?? '') && permit(ctx, 'permit_post_q', userlevel)) {
      errors.categoryid = 'not_allowed';
    }
    fail(errors);

    // Fill in what was not edited, as PHP does for fields the form did not show.
    const title = input.title ?? question.title;
    const content = input.content ?? question.content;
    const format = input.format ?? question.format;
    const values = {
      title, content, format, text: input.content !== undefined ? input.text : text.viewerText(content, format),
      tagstring: input.tags ? text.tagsToTagstring(input.tags) : (question.tags ?? ''),
      notify: setNotify(question, rules, input), name: input.name ?? null, extra: input.extra,
    };
    const type = await questionSetContent(ctx, page, question, values, remoderate, silent);
    const categoryid = 'categoryid' in input ? input.categoryid : question.categoryid;
    if (String(options.get('tags_or_categories')).includes('c') && String(categoryid ?? '') !== String(question.categoryid ?? '')) {
      await questionSetCategory(ctx, page, question, categoryid, silent);
    }
    return { id: question.postid, type };
  }

  // qa_page_q_edit_a_submit(), including converting the answer to a comment.
  async function editAnswer(ctx, page, answer, body) {
    const { options } = ctx;
    const rules = postRules(ctx, answer, page.question, page.answers, page.achildren);
    if (!rules.editbutton) throw new ApiError(403, 'edit_not_allowed');
    permitEdit(ctx, answer, rules, 'permit_edit_a');
    const commenton = body.convertToCommentOn ?? null;
    if (commenton !== null && !Number.isInteger(commenton)) throw new ApiError(400, 'invalid_input', { convertToCommentOn: 'invalid' });
    const input = { ...readAuthorFields(ctx, body, rules), ...readEditContent(body, answer) };
    const silent = readSilent(ctx, body, answer);
    const remoderate = remoderation(ctx, userLevelForPost(answer, ctx.user));
    fail(filterChild(input, 'min_len_a_content', options));

    const content = input.content ?? answer.content;
    const format = input.format ?? answer.format;
    const values = { content, format, text: input.content !== undefined ? input.text : text.viewerText(content, format), notify: setNotify(answer, rules, input), name: input.name ?? null };
    const target = commenton === null ? null
      : Number(commenton) === Number(page.question.postid) ? postRules(ctx, page.question, null, null, page.qchildren)
        : Number(commenton) !== Number(answer.postid) && page.answers.find(a => Number(a.postid) === commenton)
          ? postRules(ctx, page.answers.find(a => Number(a.postid) === commenton), page.question, page.answers, page.achildren) : null;
    if (target?.commentable) {
      const limits = await ctx.q.findLimits(ctx.userid, ctx.ip, LIMIT.COMMENTS);
      if (limitsRemaining(LIMIT.COMMENTS, limits.user, limits.ip, options) <= 0) throw new ApiError(429, 'comment_limit');
      return { id: answer.postid, type: await answerToComment(ctx, page, answer, commenton, values, remoderate, silent) };
    }
    return { id: answer.postid, type: await answerSetContent(ctx, page, answer, values, remoderate, silent) };
  }

  // qa_page_q_edit_c_submit()
  async function editComment(ctx, page, comment, body) {
    const { options } = ctx;
    const rules = postRules(ctx, comment, page.parent, page.commentsfollows, null);
    if (!rules.editbutton) throw new ApiError(403, 'edit_not_allowed');
    permitEdit(ctx, comment, rules, 'permit_edit_c');
    const input = { ...readAuthorFields(ctx, body, rules), ...readEditContent(body, comment) };
    const silent = readSilent(ctx, body, comment);
    const remoderate = remoderation(ctx, userLevelForPost(comment, ctx.user));
    fail(filterChild(input, 'min_len_c_content', options));
    const content = input.content ?? comment.content;
    const format = input.format ?? comment.format;
    const values = { content, format, text: input.content !== undefined ? input.text : text.viewerText(content, format), notify: setNotify(comment, rules, input), name: input.name ?? null };
    return { id: comment.postid, type: await commentSetContent(ctx, page, comment, values, remoderate, silent) };
  }

  async function editPost(request) {
    request = await withIdentity(request);
    return repository.transaction(async q => {
      const ctx = await context(q, request);
      const post = request.postid ? await q.findPost(request.postid, { lock: true }) : undefined;
      if (!post || !['Q', 'A', 'C'].includes(post.basetype)) throw new ApiError(404, 'post_not_found');
      const page = await questionPage(ctx, post);
      const body = request.body ?? {};
      if (post.basetype === 'Q') return editQuestion(ctx, page, body);
      if (post.basetype === 'A') return editAnswer(ctx, page, post, body);
      return editComment(ctx, page, post, body);
    });
  }


  // ---------------------------------------------------------------------------------------------
  // Selecting answers, closing, status changes, deleting and claiming (pages/question-submit.php
  // qa_page_q_single_click_q/a/c, the close form and the delete button in pages/question-post.php).

  // A system action (a post hidden by flags) has no actor; user clicks always do.
  const actorOf = ctx => ({ userid: ctx.userid, cookieid: ctx.cookieid });
  async function report(ctx, actor, limitAction = null) {
    if (actor) await reportAction({ ...ctx, userid: actor.userid, cookieid: actor.cookieid }, limitAction);
  }
  const visibleEdit = (ctx, actor) => ({ updatetype: UPDATE.VISIBLE, userid: actor ? actor.userid : null, ip: ctx.ip });

  // qa_question_close_clear()
  async function questionCloseClear(ctx, page, old, actor) {
    const { q } = ctx;
    if (old.closedbyid === null) return;
    await q.setClosed(old.postid, null, { userid: actor?.userid ?? null, ip: ctx.ip });
    if (page.closepost && String(page.closepost.parentid) === String(old.postid)) {
      await unindexPost(q, page.closepost.postid);
      await q.deletePost(page.closepost.postid);
    }
    await questionBasicCacheRecalc(q, old, 1);
    await report(ctx, actor); // q_reopen
    await eventForQUser(q, old.postid, old.postid, UPDATE.CLOSED, actor?.userid ?? null, old.userid);
  }
  async function closedEvent(ctx, old, actor) { // q_close
    await report(ctx, actor);
    await eventForQUser(ctx.q, old.postid, old.postid, UPDATE.CLOSED, actor?.userid ?? null, old.userid);
  }
  // qa_question_close_duplicate()
  async function questionCloseDuplicate(ctx, page, old, originalid, actor) {
    await questionCloseClear(ctx, page, old, actor);
    await ctx.q.setClosed(old.postid, originalid, { userid: actor.userid, ip: ctx.ip });
    await questionBasicCacheRecalc(ctx.q, old, -1);
    await closedEvent(ctx, old, actor);
  }
  // qa_question_close_other()
  async function questionCloseOther(ctx, page, old, note, actor) {
    const { q } = ctx;
    await questionCloseClear(ctx, page, old, actor);
    const postid = await q.insertPost({
      type: 'NOTE', parentid: old.postid, userid: actor.userid, cookieid: actor.userid === null ? actor.cookieid : null, ip: ctx.ip,
      title: null, content: note, format: '', tagstring: null, notify: null, categoryid: old.categoryid, name: null,
    });
    await q.calcCategoryPath(postid);
    if (old.type === 'Q') await indexPost(q, postid, 'NOTE', old.postid, null, note, null);
    await q.setClosed(old.postid, postid, { userid: actor.userid, ip: ctx.ip });
    await questionBasicCacheRecalc(q, old, -1);
    await closedEvent(ctx, old, actor);
  }

  // The new type, event and whether the editor is recorded, shared by the three *_set_status() functions.
  function statusChange(base, old, status) {
    const washidden = old.type === `${base}_HIDDEN`;
    const wasqueued = old.type === `${base}_QUEUED`;
    if (status === STATUS.QUEUED) return { newtype: `${base}_QUEUED`, event: wasqueued ? null : 'requeue', setupdated: false, wasqueued };
    if (status === STATUS.HIDDEN) return { newtype: `${base}_HIDDEN`, event: washidden ? null : wasqueued ? 'reject' : 'hide', setupdated: !washidden && !wasqueued, wasqueued };
    return { newtype: base, event: wasqueued ? 'approve' : washidden ? 'reshow' : null, setupdated: !wasqueued && washidden, wasqueued };
  }
  const statusDifference = (base, old, status) => (status === STATUS.NORMAL ? (old.type !== base ? 1 : null) : (old.type === base ? -1 : null));
  async function queuedChange(q, wasqueued, status) {
    if (wasqueued) { if (status !== STATUS.QUEUED) await q.queuedcountUpdate(-1); } else if (status === STATUS.QUEUED) await q.queuedcountUpdate(1);
  }
  // qa_event_limits records hide/reject/reshow/approve as writes (not requeue).
  const reportStatus = (ctx, actor, event) => (['hide', 'reject', 'reshow', 'approve'].includes(event) ? report(ctx, actor) : undefined);
  const indexOld = (q, post, type, questionid) => indexPost(q, post.postid, type, questionid, type === 'Q' ? post.title : null, text.viewerText(post.content, post.format), type === 'Q' ? post.tags : null);

  // qa_question_set_status()
  async function questionSetStatus(ctx, page, old, status, actor) {
    const { q, options } = ctx;
    const { newtype, event, setupdated, wasqueued } = statusChange('Q', old, status);
    const wasrequeued = wasqueued && old.updated !== null;
    const answers = page.answers;
    const comments = page.commentsfollows.filter(c => c.basetype === 'C');
    const closepost = page.closepost && String(page.closepost.parentid) === String(old.postid) ? page.closepost : null;
    await unindexPost(q, old.postid);
    for (const post of [...answers, ...comments, ...(closepost ? [closepost] : [])]) await unindexPost(q, post.postid);
    await q.setType(old.postid, newtype, setupdated ? visibleEdit(ctx, actor) : null);
    if (wasqueued && status === STATUS.NORMAL && phpBool(options.get('moderate_update_time'))) {
      if (wasrequeued) await q.setUpdatedNow(old.postid);
      else { await q.setCreatedNow(old.postid); await q.updateHotness(old.postid, options); }
    }
    const difference = statusDifference('Q', old, status);
    if (difference !== null) await questionCacheRecalc(q, old, difference);
    await queuedChange(q, wasqueued, status);
    await q.updatePoints(old.userid, ['qposts', 'aselects'], options);
    if (difference !== null) await flaggedChange(q, old, difference);
    if (status === STATUS.NORMAL) {
      await indexOld(q, old, 'Q', old.postid);
      for (const answer of answers) if (answer.type === 'A') await indexOld(q, answer, 'A', old.postid);
      for (const comment of comments) {
        const answer = answers.find(a => String(a.postid) === String(comment.parentid));
        if (comment.type === 'C' && (!answer || answer.type === 'A')) await indexOld(q, comment, 'C', old.postid);
      }
      if (closepost) await indexPost(q, closepost.postid, closepost.type, old.postid, null, text.viewerText(closepost.content, closepost.format), null);
    }
    await reportStatus(ctx, actor, event);
    const userid = actor?.userid ?? null;
    if (event === 'hide' && old.userid !== null) await q.eventCreateNotEntity(old.userid, old.postid, old.postid, UPDATE.VISIBLE, userid);
    if (event === 'reshow') await eventForQUser(q, old.postid, old.postid, UPDATE.VISIBLE, userid, old.userid);
    if (wasqueued && status === STATUS.NORMAL && !wasrequeued) { // the delayed q_post, reported as the author
      const follow = old.parentid !== null ? await q.findPost(old.parentid) : null;
      if (follow) await eventForQUser(q, follow.parentid, old.postid, UPDATE.FOLLOWS, old.userid, follow.userid);
      await eventForQUser(q, old.postid, old.postid, null, old.userid);
      await eventsForTags(q, old.tags, old.postid, null, old.userid);
      await eventsForCategory(q, old.categoryid, old.postid, null, old.userid);
      await notify.questionPosted(q, options, {
        userid: old.userid, cookieid: old.cookieid, handle: await q.findHandle(old.userid), postid: old.postid, title: old.title,
        text: text.viewerText(old.content, old.format), name: old.name,
      });
    }
    if (event === 'requeue') {
      await notify.queued(q, options, { basetype: 'Q', requeue: true, handle: actor ? ctx.user?.handle ?? null : null, name: old.name, postid: old.postid, title: old.title, text: text.viewerText(old.content, old.format) });
    }
    return newtype;
  }

  // qa_answer_set_status()
  async function answerSetStatus(ctx, page, old, status, actor) {
    const { q, options } = ctx;
    const { question } = page;
    const { newtype, event, setupdated, wasqueued } = statusChange('A', old, status);
    const wasrequeued = wasqueued && old.updated !== null;
    const comments = page.commentsfollows.filter(c => c.basetype === 'C' && String(c.parentid) === String(old.postid));
    await unindexPost(q, old.postid);
    for (const comment of comments) await unindexPost(q, comment.postid);
    if (status === STATUS.HIDDEN && question.selchildid !== null && Number(question.selchildid) === Number(old.postid)) {
      await setSelchildid(ctx, question, null, [old], null);
    }
    await q.setType(old.postid, newtype, setupdated ? visibleEdit(ctx, actor) : null);
    if (wasqueued && status === STATUS.NORMAL && phpBool(options.get('moderate_update_time'))) {
      if (wasrequeued) await q.setUpdatedNow(old.postid); else await q.setCreatedNow(old.postid);
    }
    const difference = statusDifference('A', old, status);
    const open = question.closedbyid === null;
    if (difference === 1) {
      await q.acountUpdateForQ(question.postid, 1);
      if (Number(question.acount) === 0 && open) await q.unaqcountUpdate(-1);
      if (Number(old.netvotes) > Number(question.amaxvote)) {
        await q.amaxvoteUpdateForQ(question.postid, Number(old.netvotes), false);
        if (Number(question.amaxvote) === 0 && open) await q.unupaqcountUpdate(-1);
      }
      await q.updateHotness(question.postid, options);
      await q.acountUpdate(1);
    } else if (difference === -1) {
      await disableAnswerRecalc(ctx, question, old.netvotes);
    }
    await queuedChange(q, wasqueued, status);
    await q.updatePoints(old.userid, ['aposts', 'aselecteds'], options);
    if (difference !== null) await flaggedChange(q, old, difference);
    if (question.type === 'Q' && status === STATUS.NORMAL) {
      await indexOld(q, old, 'A', question.postid);
      for (const comment of comments) if (comment.type === 'C') await indexOld(q, comment, 'C', question.postid);
    }
    await reportStatus(ctx, actor, event);
    const userid = actor?.userid ?? null;
    if (event === 'hide' && old.userid !== null) await q.eventCreateNotEntity(old.userid, old.parentid, old.postid, UPDATE.VISIBLE, userid);
    if (event === 'reshow') await eventForQUser(q, old.parentid, old.postid, UPDATE.VISIBLE, userid, old.userid);
    if (wasqueued && status === STATUS.NORMAL && !wasrequeued) {
      await eventForQUser(q, question.postid, old.postid, null, old.userid, question.userid);
      await notify.answerPosted(q, options, {
        userid: old.userid, cookieid: old.cookieid, handle: await q.findHandle(old.userid), postid: old.postid, text: text.viewerText(old.content, old.format), name: old.name, question,
      });
    }
    if (event === 'requeue') {
      await notify.queued(q, options, { basetype: 'A', requeue: true, handle: actor ? ctx.user?.handle ?? null : null, name: old.name, postid: old.postid, text: text.viewerText(old.content, old.format), question });
    }
    return newtype;
  }

  // qa_comment_set_status()
  async function commentSetStatus(ctx, page, old, status, actor) {
    const { q, options } = ctx;
    const { question, parent } = page;
    const { newtype, event, setupdated, wasqueued } = statusChange('C', old, status);
    const wasrequeued = wasqueued && old.updated !== null;
    await unindexPost(q, old.postid);
    await q.setType(old.postid, newtype, setupdated ? visibleEdit(ctx, actor) : null);
    if (wasqueued && status === STATUS.NORMAL && phpBool(options.get('moderate_update_time'))) {
      if (wasrequeued) await q.setUpdatedNow(old.postid); else await q.setCreatedNow(old.postid);
    }
    const difference = statusDifference('C', old, status);
    await queuedChange(q, wasqueued, status);
    await q.updatePoints(old.userid, ['cposts'], options);
    if (difference !== null) {
      await q.ccountUpdate(difference);
      await flaggedChange(q, old, difference);
    }
    if (question.type === 'Q' && ['Q', 'A'].includes(parent.type) && status === STATUS.NORMAL) await indexOld(q, old, 'C', question.postid);
    await reportStatus(ctx, actor, event);
    const userid = actor?.userid ?? null;
    if (event === 'hide' && old.userid !== null) await q.eventCreateNotEntity(old.userid, question.postid, old.postid, UPDATE.VISIBLE, userid);
    if (event === 'reshow') await eventForQUser(q, question.postid, old.postid, UPDATE.VISIBLE, userid, old.userid);
    if (wasqueued && status === STATUS.NORMAL && !wasrequeued) { // the delayed c_post: the thread now includes this comment
      const thread = (await q.findChildren(old.parentid)).filter(c => c.type === 'C' && String(c.parentid) === String(parent.postid));
      const keyuserids = new Set(thread.filter(c => c.userid !== null).map(c => Number(c.userid)));
      const author = old.userid === null ? null : Number(old.userid);
      for (const keyuserid of keyuserids) if (keyuserid !== author) await q.eventCreateNotEntity(keyuserid, question.postid, old.postid, UPDATE.FOLLOWS, author);
      const parentUser = parent.userid === null || keyuserids.has(Number(parent.userid)) ? null : parent.userid;
      await eventForQUser(q, question.postid, old.postid, parent.basetype === 'Q' ? UPDATE.C_FOR_Q : UPDATE.C_FOR_A, author, parentUser);
      await notify.commentPosted(q, options, {
        userid: old.userid, cookieid: old.cookieid, handle: await q.findHandle(old.userid), postid: old.postid, text: text.viewerText(old.content, old.format), name: old.name,
        parent, question, thread,
      });
    }
    if (event === 'requeue') {
      await notify.queued(q, options, { basetype: 'C', requeue: true, handle: actor ? ctx.user?.handle ?? null : null, name: old.name, postid: old.postid, text: text.viewerText(old.content, old.format), question });
    }
    return newtype;
  }

  // qa_question_delete(), qa_answer_delete(), qa_comment_delete()
  async function votersPoints(ctx, postid, prefix) {
    for (const { userid, vote } of await ctx.q.postUserVotes(postid)) await ctx.q.updatePoints(userid, [vote > 0 ? `${prefix}upvotes` : `${prefix}downvotes`], ctx.options);
  }
  async function questionDelete(ctx, page, old, actor) {
    const { q, options } = ctx;
    if (page.closepost && String(page.closepost.parentid) === String(old.postid)) {
      await q.setClosed(old.postid, null, null);
      await unindexPost(q, page.closepost.postid);
      await q.deletePost(page.closepost.postid);
    }
    const votes = await q.postUserVotes(old.postid);
    const oldpath = await q.getCategoryPath(old.postid);
    await unindexPost(q, old.postid);
    await q.deletePost(old.postid);
    await q.pathQcountUpdate(oldpath);
    await q.updatePoints(old.userid, ['qposts', 'aselects', 'qvoteds', 'upvoteds', 'downvoteds'], options);
    for (const { userid, vote } of votes) await q.updatePoints(userid, [vote > 0 ? 'qupvotes' : 'qdownvotes'], options);
    await report(ctx, actor); // q_delete
  }
  async function answerDelete(ctx, page, old, actor) {
    const { q, options } = ctx;
    const { question } = page;
    const votes = await q.postUserVotes(old.postid);
    await unindexPost(q, old.postid);
    await q.deletePost(old.postid);
    if (question.selchildid !== null && Number(question.selchildid) === Number(old.postid)) {
      await q.setSelchildid(question.postid, null, null);
      await q.updatePoints(question.userid, ['aselects'], options);
    }
    await q.updatePoints(old.userid, ['aposts', 'aselecteds', 'avoteds', 'upvoteds', 'downvoteds'], options);
    for (const { userid, vote } of votes) await q.updatePoints(userid, [vote > 0 ? 'aupvotes' : 'adownvotes'], options);
    await report(ctx, actor); // a_delete
  }
  async function commentDelete(ctx, page, old, actor) {
    await unindexPost(ctx.q, old.postid);
    await ctx.q.deletePost(old.postid);
    await ctx.q.updatePoints(old.userid, ['cposts'], ctx.options);
    await report(ctx, actor); // c_delete
  }

  // qa_question_set_userid() and its answer/comment versions: claiming an anonymous post.
  const CLAIM_POINTS = {
    Q: [['qposts', 'aselects', 'qvoteds', 'upvoteds', 'downvoteds'], ['qposts', 'aselects', 'qvoteds', 'qupvotes', 'qdownvotes', 'upvoteds', 'downvoteds'], LIMIT.QUESTIONS],
    A: [['aposts', 'aselecteds', 'avoteds', 'upvoteds', 'downvoteds'], ['aposts', 'aselecteds', 'avoteds', 'aupvotes', 'adownvotes', 'upvoteds', 'downvoteds'], LIMIT.ANSWERS],
    C: [['cposts'], ['cposts'], LIMIT.COMMENTS],
  };
  async function postSetUserid(ctx, old) {
    const { q, options } = ctx;
    const [oldColumns, newColumns, limitAction] = CLAIM_POINTS[old.basetype];
    await q.setUserid(old.postid, ctx.userid);
    await q.uservoteRemoveOwn(old.postid);
    await q.recountVotes(old.postid);
    await q.updatePoints(old.userid, oldColumns, options);
    await q.updatePoints(ctx.userid, newColumns, options);
    await report(ctx, actorOf(ctx), limitAction); // *_claim counts against the posting limit
  }

  // Loads the post, its question page and the rules for the post, as the question page does.
  async function postWithRules(ctx, postid) {
    const { q } = ctx;
    const post = postid ? await q.findPost(postid, { lock: true }) : undefined;
    if (!post || !['Q', 'A', 'C'].includes(post.basetype)) throw new ApiError(404, 'post_not_found');
    post.userflag = ctx.userid !== null ? await q.userFlag(post.postid, ctx.userid) : null;
    const page = await questionPage(ctx, post);
    let rules;
    if (post.basetype === 'Q') rules = postRules(ctx, post, null, null, page.qchildren);
    else if (post.basetype === 'A') rules = postRules(ctx, post, page.question, page.answers, page.achildren);
    else rules = postRules(ctx, post, page.parent, page.commentsfollows, null);
    return { post, page, rules };
  }
  const transaction = async (request, work) => {
    const resolved = await withIdentity(request);
    return repository.transaction(async q => work(await context(q, resolved)));
  };

  async function selectAnswer(request) {
    return transaction(request, async ctx => {
      const { post: question, page, rules } = await postWithRules(ctx, request.questionid);
      if (question.basetype !== 'Q') throw new ApiError(404, 'question_not_found');
      const answerId = request.body?.answerId ?? null;
      if (answerId !== null && !Number.isInteger(answerId)) throw new ApiError(400, 'invalid_input', { answerId: 'invalid' });
      if (!rules.aselectable) throw new ApiError(403, 'select_not_allowed');
      if (answerId === null) {
        if (question.selchildid !== null) await setSelchildid(ctx, question, null, page.answers);
      } else {
        if (!page.answers.some(a => Number(a.postid) === answerId)) throw new ApiError(404, 'answer_not_found');
        await setSelchildid(ctx, question, answerId, page.answers);
      }
      return { id: question.postid, selectedAnswerId: answerId };
    });
  }

  async function closeQuestion(request) {
    return transaction(request, async ctx => {
      const { post: question, page, rules } = await postWithRules(ctx, request.questionid);
      if (question.basetype !== 'Q') throw new ApiError(404, 'question_not_found');
      if (!rules.closeable) throw new ApiError(403, 'close_not_allowed');
      permitEdit(ctx, question, rules, 'permit_close_q');
      const details = (stringField(request.body ?? {}, 'details') ?? '').trim();
      // qa_page_q_close_q_submit(): a link to another question closes as a duplicate; other text is a note.
      const sanitized = details.replace(/[^A-Za-z0-9$\-_.+!*'(),{}|\\^~[\]`<>#%";/?:@&=]/g, '');
      if (isUrl(sanitized)) {
        const ids = [...new Set(sanitized.split(/[=/&]/).filter(part => /^[0-9]+$/.test(part)))].map(Number);
        const questionIds = await ctx.q.filterQuestionIds(ids);
        if (questionIds.length !== 1 || Number(questionIds[0]) === Number(question.postid)) throw new ApiError(400, 'validation_failed', { details: 'duplicate_not_found' });
        await questionCloseDuplicate(ctx, page, question, questionIds[0], actorOf(ctx));
        return { id: question.postid, closedBy: { duplicateOf: Number(questionIds[0]) } };
      }
      if (!details.length) throw new ApiError(400, 'validation_failed', { details: 'required' });
      await questionCloseOther(ctx, page, question, details, actorOf(ctx));
      return { id: question.postid, closedBy: { note: details } };
    });
  }

  async function reopenQuestion(request) {
    return transaction(request, async ctx => {
      const { post: question, page, rules } = await postWithRules(ctx, request.questionid);
      if (question.basetype !== 'Q') throw new ApiError(404, 'question_not_found');
      if (!rules.reopenable) throw new ApiError(403, 'reopen_not_allowed');
      await questionCloseClear(ctx, page, question, actorOf(ctx));
      return { id: question.postid };
    });
  }

  // Hide, reject, reshow or approve, with the button checks of qa_page_q_single_click_q/a/c.
  async function setStatus(request) {
    return transaction(request, async ctx => {
      const { post, page, rules } = await postWithRules(ctx, request.postid);
      const action = request.body?.action;
      const allowed = { hide: rules.hideable, reject: rules.moderatable, reshow: rules.reshowable, approve: rules.moderatable };
      if (!(action in allowed)) throw new ApiError(400, 'invalid_input', { action: 'invalid' });
      if (!allowed[action]) throw new ApiError(403, `${action}_not_allowed`);
      let status = STATUS.HIDDEN;
      if (action === 'reshow' || action === 'approve') {
        // A reshown post goes back to the queue if the author's new posts would be moderated.
        status = rules.moderatable || rules.reshowimmed ? STATUS.NORMAL
          : moderationReason(userLevelForPost(post, ctx.user), ctx.user, ctx.ip, ctx.options) !== false ? STATUS.QUEUED : STATUS.NORMAL;
      }
      const change = { Q: questionSetStatus, A: answerSetStatus, C: commentSetStatus }[post.basetype];
      return { id: post.postid, type: await change(ctx, page, post, status, actorOf(ctx)) };
    });
  }

  async function deletePost(request) {
    return transaction(request, async ctx => {
      const { post, page, rules } = await postWithRules(ctx, request.postid);
      if (!rules.deleteable) throw new ApiError(403, 'delete_not_allowed');
      const remove = { Q: questionDelete, A: answerDelete, C: commentDelete }[post.basetype];
      await remove(ctx, page, post, actorOf(ctx));
      return { id: post.postid, deleted: true };
    });
  }

  async function claimPost(request) {
    return transaction(request, async ctx => {
      const { post, rules } = await postWithRules(ctx, request.postid);
      if (!rules.claimable) throw new ApiError(403, 'claim_not_allowed');
      const limitAction = CLAIM_POINTS[post.basetype][2];
      const limits = await ctx.q.findLimits(ctx.userid, ctx.ip, limitAction);
      if (limitsRemaining(limitAction, limits.user, limits.ip, ctx.options) <= 0) {
        throw new ApiError(429, { Q: 'ask_limit', A: 'answer_limit', C: 'comment_limit' }[post.basetype]);
      }
      await postSetUserid(ctx, post);
      return { id: post.postid, userid: ctx.userid };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Flags: the flag, unflag and clear-flags buttons of qa_page_q_single_click_q/a/c, with
  // qa_flag_error_html(), qa_flag_set_tohide(), qa_flag_clear() and qa_flags_clear_all().

  const FLAG_ERRORS = { login: [401, 'unauthenticated'], confirm: [403, 'flag_must_confirm'], limit: [429, 'flag_limit'] };

  async function flagPost(request) {
    return transaction(request, async ctx => {
      const { q, options } = ctx;
      const { post, page, rules } = await postWithRules(ctx, request.postid);
      if (!rules.flagbutton) throw new ApiError(403, 'flag_not_allowed');
      // qa_flag_error_html()
      if (post.userid !== null && Number(post.userid) === Number(ctx.userid)) throw new ApiError(403, 'flag_not_allowed');
      const limits = await q.findLimits(ctx.userid, ctx.ip, LIMIT.FLAGS);
      const error = permit(ctx, 'permit_flag', rules.userlevel, LIMIT.FLAGS, limits);
      if (error) throw new ApiError(...(FLAG_ERRORS[error] ?? [403, 'no_permission']));
      // qa_flag_set_tohide()
      await q.userflagSet(post.postid, ctx.userid, true);
      await q.recountFlags(post.postid, 1);
      await q.flaggedcountUpdate(1);
      await report(ctx, actorOf(ctx), LIMIT.FLAGS); // *_flag
      const flagcount = Number(post.flagcount) + 1;
      await notify.flagged(q, options, { flagcount, oldpost: { ...post, handle: await q.findHandle(post.userid) }, question: page.question });
      let type = post.type;
      if (flagcount >= Number(options.get('flagging_hide_after'))) {
        // The page hides it as a system action ("not really by this user"), passing the post as it
        // was loaded before the flag.
        const change = { Q: questionSetStatus, A: answerSetStatus, C: commentSetStatus }[post.basetype];
        type = await change(ctx, page, post, STATUS.HIDDEN, null);
      }
      return { id: post.postid, flagcount, type };
    });
  }

  async function unflagPost(request) {
    return transaction(request, async ctx => {
      const { q } = ctx;
      const { post, rules } = await postWithRules(ctx, request.postid);
      if (!rules.unflaggable) throw new ApiError(403, 'unflag_not_allowed');
      // qa_flag_clear()
      await q.userflagSet(post.postid, ctx.userid, false);
      await q.recountFlags(post.postid, -1);
      await q.flaggedcountUpdate(-1);
      await report(ctx, actorOf(ctx)); // *_unflag
      return { id: post.postid, flagcount: Number(post.flagcount) - 1 };
    });
  }

  // The question page offers this button (clearflaggable); the admin flagged-posts page only checks
  // permit_hide_show (qa_admin_single_click), so either is accepted.
  async function clearFlags(request) {
    return transaction(request, async ctx => {
      const { q } = ctx;
      const { post, rules } = await postWithRules(ctx, request.postid);
      if (!rules.clearflaggable && permit(ctx, 'permit_hide_show', rules.userlevel)) throw new ApiError(403, 'clearflags_not_allowed');
      // qa_flags_clear_all()
      const cleared = await q.userflagsClearAll(post.postid);
      await q.flaggedcountUpdate(-cleared);
      await q.resetFlags(post.postid);
      await report(ctx, actorOf(ctx)); // *_clearflags
      return { id: post.postid, flagcount: 0 };
    });
  }

  return { flagPost, unflagPost, clearFlags, editPost, selectAnswer, closeQuestion, reopenQuestion, setStatus, deletePost, claimPost, internals: { questionPage, questionCacheRecalc, questionBasicCacheRecalc, disableAnswerRecalc, flaggedChange, eventsForCategory } };
}
// PHP's FILTER_VALIDATE_URL: a scheme and, for web addresses, a host.
function isUrl(value) {
  try {
    const url = new URL(value);
    return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) && (!/^https?:$/.test(url.protocol) || url.hostname !== '');
  } catch { return false; }
}

module.exports = { createPostChangeService };
