// Moderating and administering users. Ports the admin rules and buttons of pages/user-profile.php
// (who may edit, which levels they may assign, approve, block, hide all posts, delete), the user
// actions of qa_admin_single_click() (app/admin.php, the approve-users page), and qa_set_user_level(),
// qa_set_user_blocked(), qa_delete_user() and qa_db_user_levels_set() with the event modules' parts
// (the approval email and the actor's last write).
const { ApiError } = require('../errors');
const { phpBool } = require('../q2a/php');
const { LEVEL, userPermitError } = require('../q2a/permissions');
const text = require('../q2a/text');
const notify = require('../q2a/notify');

const FLAGS = { EMAIL_CONFIRMED: 1, USER_BLOCKED: 2, SHOW_AVATAR: 4, SHOW_GRAVATAR: 8, MUST_APPROVE: 512 };
const MAX = { EMAIL: 80, PROFILE: 8000 };

function createUserAdminService(repository, { identify, postChangeService }) {
  async function transaction(request, work) {
    const identity = await identify(request.token);
    if (!identity) throw new ApiError(401, 'unauthenticated');
    return repository.transaction(async q => {
      const options = await q.loadOptions();
      const actor = await q.findActor(identity.id);
      if (!actor) throw new ApiError(401, 'unauthenticated');
      const target = request.handle ? await q.findAccountByHandle(request.handle) : undefined;
      if (!target) throw new ApiError(404, 'user_not_found');
      const levels = await q.userLevels(target.userid);
      return work({ q, options, actor, target, levels, ip: request.ip, rules: rulesFor(actor, target, levels, options, request.ip) });
    });
  }

  // pages/user-profile.php: what the signed-in user may change about this user.
  function rulesFor(actor, target, levels, options, ip) {
    const loginlevel = Number(actor.level);
    const maxuserlevel = Math.max(Number(target.level), ...levels.map(row => Number(row.level)));
    const blocked = Boolean(Number(target.flags) & FLAGS.USER_BLOCKED);
    let maxlevelassign = null;
    let fieldseditable = false;
    if (Number(actor.userid) !== Number(target.userid) && (loginlevel >= LEVEL.SUPER || loginlevel > maxuserlevel) &&
      !userPermitError({ permitoption: null, user: actor, ip, options })) {
      if (loginlevel >= LEVEL.SUPER) maxlevelassign = LEVEL.SUPER;
      else if (loginlevel >= LEVEL.ADMIN) maxlevelassign = LEVEL.MODERATOR;
      else if (loginlevel >= LEVEL.MODERATOR) maxlevelassign = LEVEL.EXPERT;
      if (loginlevel >= LEVEL.ADMIN) fieldseditable = true;
      if (maxlevelassign !== null && blocked) maxlevelassign = Math.min(maxlevelassign, LEVEL.EDITOR);
    }
    return {
      loginlevel, maxuserlevel, maxlevelassign, fieldseditable, blocked,
      editable: fieldseditable || maxlevelassign !== null,
      // block, unblock, hide all and delete need a user below moderator; the page offers hide all and
      // delete only once the user is blocked
      manageable: maxlevelassign !== null && maxuserlevel < LEVEL.MODERATOR,
      removable: maxlevelassign !== null && maxuserlevel < LEVEL.MODERATOR && blocked,
      // qa_admin_single_click(): moderators approve users up to "approved" and block anyone
      adminApprove: loginlevel >= LEVEL.MODERATOR && Number(target.level) <= LEVEL.APPROVED,
      adminBlock: loginlevel >= LEVEL.MODERATOR,
    };
  }

  // qa_set_user_level() as the profile and approve pages call it (with the old level, so the count
  // of users awaiting approval is recounted rather than adjusted).
  async function setUserLevel(ctx, level) {
    const { q, options, target, actor } = ctx;
    const oldlevel = Number(target.level);
    await q.userSetLevel(target.userid, level);
    if ((oldlevel < LEVEL.APPROVED) !== (level < LEVEL.APPROVED)) await q.uapprovecountUpdate();
    if (level >= LEVEL.APPROVED) await q.userSetFlag(target.userid, FLAGS.MUST_APPROVE, false);
    await q.userWritten(actor.userid, ctx.ip); // u_level
    await notify.userLevelChanged(q, options, { userid: target.userid, handle: target.handle, level, oldlevel });
  }

  // The profile page's level and category levels, or the approve buttons.
  async function changeLevel(request) {
    return transaction(request, async ctx => {
      const { q, options, rules, target } = ctx;
      const body = request.body ?? {};
      // The level may be left out when only category levels change.
      if (body.level !== undefined && !Number.isInteger(body.level)) throw new ApiError(400, 'invalid_input', { level: 'invalid' });
      if (body.level === undefined && body.categoryLevels === undefined) throw new ApiError(400, 'invalid_input', { level: 'required' });
      let level = Number(target.level);
      if (body.level !== undefined) {
        if (rules.maxlevelassign !== null) level = Math.min(rules.maxlevelassign, body.level);
        else if (rules.adminApprove && body.level === LEVEL.APPROVED) level = LEVEL.APPROVED;
        else throw new ApiError(403, 'level_not_allowed');
        if (level !== Number(target.level)) await setUserLevel(ctx, level);
      }
      if (body.categoryLevels !== undefined) {
        if (rules.maxlevelassign === null || !String(options.get('tags_or_categories')).includes('c')) throw new ApiError(403, 'level_not_allowed');
        if (!Array.isArray(body.categoryLevels)) throw new ApiError(400, 'invalid_input', { categoryLevels: 'invalid' });
        const levels = [];
        for (const entry of body.categoryLevels) {
          if (!Number.isInteger(entry?.categoryid) || !Number.isInteger(entry?.level)) throw new ApiError(400, 'invalid_input', { categoryLevels: 'invalid' });
          if (!(await q.categoryExists(entry.categoryid))) throw new ApiError(400, 'invalid_input', { categoryLevels: 'invalid' });
          levels.push({ entitytype: 'C', entityid: entry.categoryid, level: Math.min(rules.maxlevelassign, entry.level) });
        }
        await q.userLevelsSet(target.userid, levels);
      }
      return { handle: target.handle, level };
    });
  }

  // qa_set_user_blocked() as the profile and approve pages call it (with the handle, so the flag is
  // set and the count of users awaiting approval recounted even if nothing changed).
  async function setBlocked(request, blocked) {
    return transaction(request, async ctx => {
      const { q, rules, target, actor } = ctx;
      if (!(rules.manageable || (blocked && rules.adminBlock))) throw new ApiError(403, `${blocked ? 'block' : 'unblock'}_not_allowed`);
      await q.userSetFlag(target.userid, FLAGS.USER_BLOCKED, blocked);
      await q.uapprovecountUpdate();
      await q.userWritten(actor.userid, ctx.ip); // u_block / u_unblock
      return { handle: target.handle, blocked };
    });
  }

  // The profile page's admin edit form: email and profile fields for admins, removing the avatar
  // for anyone who may edit. Fields that pass their checks are saved even when others fail.
  async function editUser(request) {
    return transaction(request, async ctx => {
      const { q, rules, target, actor } = ctx;
      const body = request.body ?? {};
      if (!rules.editable) throw new ApiError(403, 'edit_not_allowed');
      const errors = {};
      if (body.removeAvatar === true) {
        await q.userSetFlag(target.userid, FLAGS.SHOW_AVATAR, false);
        await q.userSetFlag(target.userid, FLAGS.SHOW_GRAVATAR, false);
        if (target.avatarblobid) {
          await q.clearAvatar(target.userid);
          await q.blobDelete(target.avatarblobid);
        }
      }
      if (rules.fieldseditable) {
        if (body.email !== undefined) {
          if (typeof body.email !== 'string') throw new ApiError(400, 'invalid_input', { email: 'invalid' });
          const email = text.postText(body.email) ?? '';
          // qa_handle_email_filter() for the email only (the handle is not changed here)
          if (!email.length) errors.email = 'required';
          else if (!text.emailValidate(email)) errors.email = 'invalid';
          else if (text.strlen(email) > MAX.EMAIL) errors.email = 'max_length';
          else if ((await q.findUseridsByEmail(email)).some(id => id !== Number(target.userid))) errors.email = 'exists';
          if (!errors.email && email !== target.email) {
            await q.userSetEmail(target.userid, email);
            await q.userSetFlag(target.userid, FLAGS.EMAIL_CONFIRMED, false);
          }
        }
        const profile = body.profile ?? {};
        if (typeof profile !== 'object' || Array.isArray(profile)) throw new ApiError(400, 'invalid_input', { profile: 'invalid' });
        for (const { title } of await q.userFields()) {
          if (!Object.hasOwn(profile, title)) continue;
          if (profile[title] !== null && typeof profile[title] !== 'string') throw new ApiError(400, 'invalid_input', { [`profile.${title}`]: 'invalid' });
          const value = text.postText(profile[title]) ?? '';
          if (text.strlen(value) > MAX.PROFILE) errors[`profile.${title}`] = 'max_length';
          else await q.profileSet(target.userid, title, value);
        }
        await q.userWritten(actor.userid, ctx.ip); // u_edit
      }
      return { handle: target.handle, errors };
    });
  }

  // qa_delete_user(): the account goes; votes and flags it gave are recounted, with their posts' points.
  async function deleteUser(request) {
    return transaction(request, async ctx => {
      const { q, options, rules, target } = ctx;
      if (!rules.removable || rules.loginlevel < LEVEL.ADMIN) throw new ApiError(403, 'delete_not_allowed');
      const postids = await q.userVotedFlaggedPostids(target.userid);
      await q.userDelete(target.userid);
      if (target.points !== null && target.points !== undefined) await q.userpointscountUpdate(-1);
      if (!(Number(target.flags) & FLAGS.USER_BLOCKED) && Number(target.level) < LEVEL.APPROVED) await q.uapprovecountUpdate(-1);
      for (const postid of postids) await q.recountVotesAndFlags(postid);
      for (const userid of await q.postsUserids(postids)) await q.updatePoints(userid, ['avoteds', 'qvoteds', 'upvoteds', 'downvoteds'], options);
      return { handle: target.handle, deleted: true };
    });
  }

  // The profile page's "hide all posts" button: every visible or queued post by the user is hidden
  // (queued ones rejected), each as the post status change the question page makes.
  async function hidePosts(request) {
    const postids = await transaction(request, async ctx => {
      const { q, options, rules, actor } = ctx;
      if (!rules.removable || userPermitError({ permitoption: 'permit_hide_show', user: actor, ip: ctx.ip, options })) throw new ApiError(403, 'hide_not_allowed');
      return q.userVisiblePostids(ctx.target.userid);
    });
    const hidden = [];
    for (const postid of postids) {
      for (const action of ['hide', 'reject']) {
        try {
          await postChangeService.setStatus({ token: request.token, ip: request.ip, postid, body: { action } });
          hidden.push(postid);
          break;
        } catch (error) {
          if (error.status !== 403 && error.status !== 404) throw error; // not offered for this post (already hidden with its question, or queued)
        }
      }
    }
    return { hidden };
  }

  return {
    changeLevel, editUser, deleteUser, hidePosts,
    approveUser: request => changeLevel({ ...request, body: { level: LEVEL.APPROVED } }),
    blockUser: request => setBlocked(request, true),
    unblockUser: request => setBlocked(request, false),
    rulesFor,
  };
}
module.exports = { createUserAdminService };
