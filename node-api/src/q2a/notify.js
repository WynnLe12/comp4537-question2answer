// Port of the qa_event_notify module (qa-include/plugins/qa-event-notify.php): the emails Q2A sends
// when something happens. Each function takes the event's parameters as PHP reports them; emails are
// built inside the transaction and sent once it commits (queueNotification()).
const { phpBool, phpNum } = require('./php');
const text = require('./text');
const { queueNotification, lang: emails } = require('./mail');
const { qPathAbsolute, pathAbsolute } = require('./paths');
const { postIsByUser } = require('./permissions');
const strings = require('../data/lang-strings.json');

const LEVEL_APPROVED = 10; // QA_USER_LEVEL_APPROVED
const anonymous = strings['main/anonymous'];
const censor = (options, value) => text.blockWordsReplace(value ?? '', options.get('block_bad_words'));
// qa_viewer_text() with the block-words option
const viewerText = (options, content, format) => censor(options, text.viewerText(content ?? '', format ?? ''));
// The name shown for the author of a post: the user's handle, the anonymous name given, or "anonymous".
const posterName = (handle, name) => handle ?? (String(name ?? '').length ? name : anonymous);
const admin = options => ({ userid: null, email: options.get('feedback_email'), handle: null });

// q_post: the author of the answer being followed, and the admin if notify_admin_q_post.
async function questionPosted(q, options, { userid, cookieid, handle, postid, title, text: plain, name, followanswer = null }) {
  const sendhandle = posterName(handle, name);
  if (followanswer && followanswer.notify !== null && followanswer.notify !== undefined && !postIsByUser(followanswer, userid, cookieid)) {
    await queueNotification(q, options, {
      userid: followanswer.userid, email: followanswer.notify, handle: followanswer.handle ?? null,
      subject: emails.a_followed_subject, body: emails.a_followed_body,
      subs: { '^q_handle': sendhandle, '^q_title': censor(options, title), '^a_content': viewerText(options, followanswer.content, followanswer.format), '^url': qPathAbsolute(options, postid, title) },
    });
  }
  if (phpBool(options.get('notify_admin_q_post'))) {
    await queueNotification(q, options, {
      ...admin(options), subject: emails.q_posted_subject, body: emails.q_posted_body,
      subs: { '^q_handle': sendhandle, '^q_title': title, '^q_content': plain, '^url': qPathAbsolute(options, postid, title) },
    });
  }
}

// a_post: the question's author.
async function answerPosted(q, options, { userid, cookieid, handle, postid, text: plain, name, question }) {
  if (question.notify === null || question.notify === undefined || postIsByUser(question, userid, cookieid)) return;
  await queueNotification(q, options, {
    userid: question.userid, email: question.notify, handle: question.handle ?? null,
    subject: emails.q_answered_subject, body: emails.q_answered_body,
    subs: { '^a_handle': posterName(handle, name), '^q_title': question.title, '^a_content': censor(options, plain), '^url': qPathAbsolute(options, question.postid, question.title, 'A', postid) },
  });
}

// c_post: the parent's author, then earlier commenters on the same parent, each user or email once.
async function commentPosted(q, options, { userid, cookieid, handle, postid, text: plain, name, parent, question, thread }) {
  const onQuestion = parent.basetype === 'Q';
  const subs = {
    '^c_handle': posterName(handle, name),
    '^c_context': censor(options, onQuestion ? parent.title : text.viewerText(parent.content ?? '', parent.format ?? '')),
    '^c_content': censor(options, plain),
    '^url': qPathAbsolute(options, question.postid, question.title, 'C', postid),
  };
  const sentToEmail = new Set();
  const sentToUser = new Set();
  const remember = (sendemail, senduserid) => {
    if (text.emailValidate(sendemail ?? '')) sentToEmail.add(sendemail);
    else if (senduserid !== null && senduserid !== undefined) sentToUser.add(String(senduserid));
  };
  if (parent.notify !== null && parent.notify !== undefined && !postIsByUser(parent, userid, cookieid)) {
    remember(parent.notify, parent.userid);
    await queueNotification(q, options, {
      userid: parent.userid, email: parent.notify, handle: parent.handle ?? null,
      subject: onQuestion ? emails.q_commented_subject : emails.a_commented_subject,
      body: onQuestion ? emails.q_commented_body : emails.a_commented_body, subs,
    });
  }
  for (const comment of thread) {
    if (comment.notify === null || comment.notify === undefined || postIsByUser(comment, userid, cookieid)) continue;
    if (text.emailValidate(comment.notify)) {
      if (sentToEmail.has(comment.notify)) continue;
    } else if (comment.userid !== null && comment.userid !== undefined && sentToUser.has(String(comment.userid))) continue;
    remember(comment.notify, comment.userid);
    await queueNotification(q, options, {
      userid: comment.userid, email: comment.notify, handle: comment.handle ?? null,
      subject: emails.c_commented_subject, body: emails.c_commented_body, subs,
    });
  }
}

// q_queue, a_queue, c_queue and their *_requeue: the admin if moderate_notify_admin.
async function queued(q, options, { basetype, requeue, handle, name, postid, title = null, text: plain, question }) {
  if (!phpBool(options.get('moderate_notify_admin'))) return;
  const url = basetype === 'Q' ? qPathAbsolute(options, postid, title) : qPathAbsolute(options, question.postid, question.title, basetype, postid);
  await queueNotification(q, options, {
    ...admin(options),
    subject: requeue ? emails.remoderate_subject : emails.moderate_subject,
    body: requeue ? emails.remoderate_body : emails.moderate_body,
    subs: {
      '^p_handle': posterName(handle, name),
      '^p_context': basetype === 'Q' ? `${title ?? ''}\n\n${plain}`.trim() : plain,
      '^url': url, '^a_url': pathAbsolute(options, 'admin/moderate'),
    },
  });
}

// q_flag, a_flag, c_flag: the admin on the first flag(s) and then every flagging_notify_every.
async function flagged(q, options, { flagcount, oldpost, question }) {
  const notifycount = flagcount - phpNum(options.get('flagging_notify_first'));
  const every = phpNum(options.get('flagging_notify_every'));
  if (notifycount < 0 || (every ? notifycount % every : notifycount) !== 0) return;
  await queueNotification(q, options, {
    ...admin(options), subject: emails.flagged_subject, body: emails.flagged_body,
    subs: {
      '^p_handle': posterName(oldpost.handle ?? null, oldpost.name),
      '^flags': flagcount === 1 ? strings['main/1_flag'] : strings['main/x_flags'].split('^').join(String(flagcount)),
      '^p_context': `${oldpost.title ?? ''}\n\n${text.viewerText(oldpost.content ?? '', oldpost.format ?? '')}`.trim(),
      '^url': qPathAbsolute(options, question.postid, question.title, oldpost.basetype, oldpost.postid),
      '^a_url': pathAbsolute(options, 'admin/flagged'),
    },
  });
}

// a_select: the selected answer's author.
async function answerSelected(q, options, { userid, cookieid, handle, answer, question }) {
  if (answer.notify === null || answer.notify === undefined || postIsByUser(answer, userid, cookieid)) return;
  await queueNotification(q, options, {
    userid: answer.userid, email: answer.notify, handle: answer.handle ?? null,
    subject: emails.a_selected_subject, body: emails.a_selected_body,
    subs: {
      '^s_handle': handle ?? anonymous, '^q_title': censor(options, question.title),
      '^a_content': viewerText(options, answer.content, answer.format), '^url': qPathAbsolute(options, question.postid, question.title, 'A', answer.postid),
    },
  });
}

// u_register: the admin if register_notify_admin.
async function userRegistered(q, options, { handle }) {
  if (!phpBool(options.get('register_notify_admin'))) return;
  await queueNotification(q, options, {
    ...admin(options), subject: emails.u_registered_subject,
    body: phpBool(options.get('moderate_users')) ? emails.u_to_approve_body : emails.u_registered_body,
    subs: { '^u_handle': handle, '^url': pathAbsolute(options, `user/${handle}`), '^a_url': pathAbsolute(options, 'admin/approve') },
  });
}

// u_level: the user, when an admin approves them.
async function userLevelChanged(q, options, { userid, handle, level, oldlevel }) {
  if (!(level >= LEVEL_APPROVED && oldlevel < LEVEL_APPROVED)) return;
  await queueNotification(q, options, {
    userid, email: null, handle, subject: emails.u_approved_subject, body: emails.u_approved_body,
    subs: { '^url': pathAbsolute(options, `user/${handle}`) },
  });
}

// u_wall_post: the wall's owner, unless they wrote it.
async function wallPosted(q, options, { userid, handle, touserid, tohandle, text: plain }) {
  if (Number(userid) === Number(touserid)) return;
  await queueNotification(q, options, {
    userid: touserid, email: null, handle: tohandle, subject: emails.wall_post_subject, body: emails.wall_post_body,
    subs: { '^f_handle': handle ?? anonymous, '^post': censor(options, plain), '^url': pathAbsolute(options, `user/${tohandle}`, null, 'wall') },
  });
}

module.exports = { questionPosted, answerPosted, commentPosted, queued, flagged, answerSelected, userRegistered, userLevelChanged, wallPosted, strings };
