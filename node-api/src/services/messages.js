// Private messages and wall posts. Ports the checks of pages/message.php, qa_wall_error_html(),
// qa_wall_posts_add_rules() and the delete handlers (pages/user-wall.php, pages/user-profile.php,
// ajax/click-wall.php, ajax/click-pm.php), the writes of qa_pm_send(), qa_wall_add_post(),
// qa_wall_delete_post() and qa_pm_delete() (app/messages.php), and the message branches of the
// qa_event_limits module.
const { ApiError } = require('../errors');
const { phpBool } = require('../q2a/php');
const { LIMIT, userPermitError } = require('../q2a/permissions');
const text = require('../q2a/text');
const notify = require('../q2a/notify');
const { prepareNotification, sendEmail, strtr, lang } = require('../q2a/mail');
const { pathAbsolute } = require('../q2a/paths');

const USER_FLAGS = { NO_MESSAGES: 16, NO_WALL_POSTS: 256 }; // QA_USER_FLAGS_*
const MAX_CONTENT = 12000; // the qa_messages.content column

// The message as the page reads it (qa_post_text()), checked against the column's size.
function readContent(body, emptyTest) {
  const value = body?.content;
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, 'invalid_input', { content: 'invalid' });
  const content = text.removeUtf8mb4(text.postText(value) ?? '');
  if (emptyTest(content)) throw new ApiError(400, 'validation_failed', { content: 'required' });
  if (text.strlen(content) > MAX_CONTENT) throw new ApiError(400, 'validation_failed', { content: 'max_length' });
  return content;
}

function createMessageService(repository, { identify }) {
  // Everything happens for a signed-in user; returns the user, options and the request context.
  async function transaction(request, work) {
    const identity = await identify(request.token);
    if (!identity) throw new ApiError(401, 'unauthenticated');
    return repository.transaction(async q => {
      const options = await q.loadOptions();
      const user = await q.findActor(identity.id);
      if (!user) throw new ApiError(401, 'unauthenticated');
      const period = Math.trunc(options.dbTime / 3600);
      return work({ q, options, user, ip: request.ip, period });
    });
  }
  const permitError = (ctx, permitoption, limitAction, limits) =>
    userPermitError({ permitoption, limitAction, user: ctx.user, ip: ctx.ip, options: ctx.options, limits });

  // pages/message.php with qa_pm_send()
  async function sendMessage(request) {
    const sent = await transaction(request, async ctx => {
      const { q, options, user } = ctx;
      if (request.handle === user.handle) throw new ApiError(403, 'no_permission');
      const to = request.handle ? await q.findUserByHandle(request.handle) : undefined;
      if (!phpBool(options.get('allow_private_messages')) || !to) throw new ApiError(404, 'user_not_found');
      if (Number(to.flags) & USER_FLAGS.NO_MESSAGES) throw new ApiError(403, 'messages_disabled');
      const limits = await q.findLimits(user.userid, ctx.ip, LIMIT.MESSAGES);
      const error = permitError(ctx, null, LIMIT.MESSAGES, limits);
      if (error === 'limit') throw new ApiError(429, 'message_limit');
      if (error) throw new ApiError(403, 'no_permission');
      // PHP's empty(): "0" counts as empty too.
      const content = readContent(request.body, value => value === '' || value === '0');
      const id = phpBool(options.get('show_message_history')) ? await q.messageCreate(user.userid, to.userid, content, '', false) : null;
      // u_message: counted against the message limit, and recorded as the user's last write.
      await q.incrementLimits(user.userid, ctx.ip, LIMIT.MESSAGES, ctx.period);
      await q.userWritten(user.userid, ctx.ip);
      // qa_pm_send_notification(): the recipient is emailed the message, with a reply link unless
      // the sender has switched off private messages.
      const canreply = !(Number(user.flags) & USER_FLAGS.NO_MESSAGES);
      const more = strtr(canreply ? lang.private_message_reply : lang.private_message_info, {
        '^f_handle': user.handle, '^url': pathAbsolute(options, canreply ? `message/${user.handle}` : `user/${user.handle}`),
      });
      const email = await prepareNotification(q, options, {
        userid: to.userid, email: null, handle: to.handle, subject: lang.private_message_subject, body: lang.private_message_body,
        subs: { '^message': content, '^f_handle': user.handle, '^f_url': pathAbsolute(options, `user/${user.handle}`), '^more': more, '^a_url': pathAbsolute(options, 'account') },
      });
      return { id, to: { userid: to.userid, handle: to.handle }, email, options };
    });
    // Sent after the message is saved; the page reports whether the email went out.
    const emailed = sent.email ? await sendEmail(sent.options, sent.email) : false;
    return { id: sent.id, to: sent.to, emailed };
  }

  // qa_wall_error_html() and the wall form, with qa_wall_add_post()
  async function postOnWall(request) {
    return transaction(request, async ctx => {
      const { q, options, user } = ctx;
      const to = request.handle ? await q.findUserByHandle(request.handle) : undefined;
      if (!to) throw new ApiError(404, 'user_not_found');
      if (!phpBool(options.get('allow_user_walls'))) throw new ApiError(403, 'no_permission');
      if ((Number(to.flags) & USER_FLAGS.NO_WALL_POSTS) && Number(user.userid) !== Number(to.userid)) throw new ApiError(403, 'wall_blocked');
      const limits = await q.findLimits(user.userid, ctx.ip, LIMIT.WALL_POSTS);
      const error = permitError(ctx, 'permit_post_wall', LIMIT.WALL_POSTS, limits);
      const failures = { limit: [429, 'wall_limit'], confirm: [403, 'wall_must_confirm'], approve: [403, 'wall_must_be_approved'] };
      if (error) throw new ApiError(...(failures[error] ?? [403, 'no_permission']));
      const content = readContent(request.body, value => value === '');
      const id = await q.messageCreate(user.userid, to.userid, content, '', true);
      await q.userRecountPosts(to.userid);
      await q.incrementLimits(user.userid, ctx.ip, LIMIT.WALL_POSTS, ctx.period); // u_wall_post
      await notify.wallPosted(q, options, { userid: user.userid, handle: user.handle, touserid: to.userid, tohandle: to.handle, text: text.viewerText(content, '') });
      return { id };
    });
  }

  // qa_wall_posts_add_rules() for the first page of the wall, then qa_wall_delete_post()
  async function deleteWallPost(request) {
    return transaction(request, async ctx => {
      const { q, options, user } = ctx;
      const message = request.messageid ? await q.findMessage(request.messageid) : undefined;
      if (!message || message.type !== 'PUBLIC') throw new ApiError(404, 'message_not_found');
      const userid = Number(user.userid);
      // "Hiding or showing any post" and "Deleting hidden posts" allow deleting from any wall.
      const deleteAll = !(permitError(ctx, 'permit_hide_show') || permitError(ctx, 'permit_delete_hidden'));
      let deleteable = Number(message.touserid) === userid || deleteAll;
      if (!deleteable) {
        // The user's own posts at the top of the wall, until someone else wrote one.
        for (const recent of await q.recentWallPosts(message.touserid, Number(options.get('page_size_wall')))) {
          if (Number(recent.fromuserid) !== userid) break;
          if (Number(recent.messageid) === Number(message.messageid)) { deleteable = true; break; }
        }
      }
      if (!deleteable) throw new ApiError(403, 'delete_not_allowed');
      await q.messageDelete(message.messageid);
      await q.userRecountPosts(message.touserid);
      return { id: message.messageid, deleted: true };
    });
  }

  // ajax/click-pm.php with qa_pm_delete(): hides the message from one box, and removes it once
  // both the sender and the recipient have hidden it.
  async function deleteMessage(request) {
    return transaction(request, async ctx => {
      const { q, user } = ctx;
      const { box } = request;
      if (box !== 'inbox' && box !== 'outbox') throw new ApiError(404, 'not_found');
      const message = request.messageid ? await q.findMessage(request.messageid) : undefined;
      const owner = message && Number(box === 'inbox' ? message.touserid : message.fromuserid) === Number(user.userid);
      const visible = message && !Number(box === 'inbox' ? message.tohidden : message.fromhidden);
      if (!message || message.type !== 'PRIVATE' || !owner || !visible) throw new ApiError(404, 'message_not_found');
      await q.messageUserHide(message.messageid, box);
      await q.messageDelete(message.messageid, false);
      return { id: message.messageid, box, deleted: true };
    });
  }

  return { sendMessage, postOnWall, deleteWallPost, deleteMessage };
}
module.exports = { createMessageService };
