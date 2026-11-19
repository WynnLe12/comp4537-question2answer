// Account and profile changes. Ports pages/account.php (saving the profile, changing the password,
// uploading an avatar), pages/confirm.php, pages/forgot.php, pages/reset.php and
// pages/unsubscribe.php, with the functions they call in app/users-edit.php (qa_handle_email_filter,
// qa_password_validate, qa_send_new_confirm, qa_complete_confirm, qa_start_reset_user,
// qa_finish_reset_user, qa_set_user_avatar), the basic filter module and the account branches of
// the qa_event_limits module.
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const { createHash } = require('node:crypto');
const { ApiError } = require('../errors');
const { phpBool, phpNum } = require('../q2a/php');
const { LIMIT, LEVEL, userPermitError } = require('../q2a/permissions');
const text = require('../q2a/text');
const { verifyPassword } = require('./auth');
const { sendNotification, lang } = require('../q2a/mail');
const { pathAbsolute } = require('../q2a/paths');

const FLAGS = { EMAIL_CONFIRMED: 1, SHOW_AVATAR: 4, SHOW_GRAVATAR: 8, NO_MESSAGES: 16, NO_MAILINGS: 32, MUST_CONFIRM: 128, NO_WALL_POSTS: 256 };
const MAX = { HANDLE: 20, EMAIL: 80, PROFILE: 8000 }; // QA_DB_MAX_*_LENGTH
const MIN_PASSWORD = 8; // QA_MIN_PASSWORD_LEN
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const sameCode = (stored, code) => String(stored ?? '').trim().toLowerCase() === String(code).toLowerCase();

// qa_post_text() for one optional string field.
function field(body, name) {
  const value = body?.[name];
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, 'invalid_input', { [name]: 'invalid' });
  return text.postText(value);
}

function createAccountService(repository, { identify, startSession, saltRounds = 10 }) {
  async function transaction(work, { token, ip, optional = false } = {}) {
    const identity = await identify(token);
    if (!identity && !optional) throw new ApiError(401, 'unauthenticated');
    return repository.transaction(async q => {
      const options = await q.loadOptions();
      const actor = identity ? await q.findActor(identity.id) : null;
      const account = identity ? await q.findAccount(identity.id) : null;
      if (identity && !account) throw new ApiError(401, 'unauthenticated');
      return work({ q, options, actor, account, ip, period: Math.trunc(options.dbTime / 3600) });
    });
  }

  // qa_handle_email_filter() with the basic filter module: errors for 'handle' and 'email'.
  async function handleEmailErrors(q, options, handle, email, olduser) {
    const errors = {};
    if (!handle.length) errors.handle = 'required';
    else if (['.', '..'].includes(handle) || /[@+/]/.test(handle)) errors.handle = 'invalid';
    else if (text.strlen(handle) > MAX.HANDLE) errors.handle = 'max_length';
    else if (text.blockWordsMatch(handle, options.get('block_bad_usernames'))) errors.handle = 'blocked';
    else if ((await q.findUseridsBy('handle', handle)).some(id => id !== Number(olduser.userid))) errors.handle = 'exists';
    if (!email.length) errors.email = 'required';
    else if (!text.emailValidate(email)) errors.email = 'invalid';
    else if (text.strlen(email) > MAX.EMAIL) errors.email = 'max_length';
    else if ((await q.findUseridsBy('email', email)).some(id => id !== Number(olduser.userid))) errors.email = 'exists';
    return errors;
  }

  // qa_send_new_confirm(): a new code, emailed with its confirmation link.
  async function sendNewConfirm(q, options, account, email = account.email) {
    const code = text.randomAlphanum(8);
    await q.userSet(account.userid, 'emailcode', code);
    const sent = await sendNotification(q, options, {
      userid: account.userid, email, handle: account.handle, subject: lang.confirm_subject, body: lang.confirm_body,
      subs: { '^url': pathAbsolute(options, 'confirm', { c: code, u: account.handle }), '^code': code },
    });
    if (!sent) throw new ApiError(503, 'email_failed');
  }

  // qa_password_validate()
  function passwordError(password) {
    return text.strlen(password) < MIN_PASSWORD ? 'too_short' : null;
  }

  // pages/account.php, "Save Profile". Like the page, fields that pass their checks are saved even
  // when others fail; the response lists the failures.
  async function saveProfile(request) {
    return transaction(async ctx => {
      const { q, options, account, actor } = ctx;
      const body = request.body ?? {};
      const userid = Number(account.userid);
      const counts = await q.userPostCounts(userid);
      const changehandle = phpBool(options.get('allow_change_usernames')) || (!Number(counts.qposts) && !Number(counts.aposts) && !Number(counts.cposts));
      const doconfirms = phpBool(options.get('confirm_user_emails')) && Number(account.level) < LEVEL.EXPERT;
      const isconfirmed = Boolean(Number(account.flags) & FLAGS.EMAIL_CONFIRMED);
      const isblocked = userPermitError({ permitoption: null, user: actor, ip: ctx.ip, options }) !== false;
      const pending = doconfirms && !isconfirmed;
      if (isblocked && !pending) throw new ApiError(403, 'no_permission');

      const email = field(body, 'email') ?? account.email;
      // Blocked users still waiting for confirmation may only correct their email address.
      let handle = isblocked || !changehandle ? account.handle : (field(body, 'handle') ?? account.handle);
      handle = text.removeUtf8mb4(handle).replace(/\p{C}+/gu, '');
      const errors = await handleEmailErrors(q, options, handle, email, account);

      if (!isblocked && !errors.handle) await q.userSet(userid, 'handle', handle);
      if (!errors.email && email !== account.email) {
        await q.userSet(userid, 'email', email);
        await q.userSetFlag(userid, FLAGS.EMAIL_CONFIRMED, false);
        if (doconfirms) await sendNewConfirm(q, options, { ...account, handle: isblocked || errors.handle ? account.handle : handle }, email);
      }
      if (!isblocked) {
        const flag = (name, current) => (body[name] === undefined ? current : Boolean(body[name]));
        const has = bit => Boolean(Number(account.flags) & bit);
        if (phpBool(options.get('allow_private_messages'))) await q.userSetFlag(userid, FLAGS.NO_MESSAGES, !flag('messages', !has(FLAGS.NO_MESSAGES)));
        if (phpBool(options.get('allow_user_walls'))) await q.userSetFlag(userid, FLAGS.NO_WALL_POSTS, !flag('wallPosts', !has(FLAGS.NO_WALL_POSTS)));
        if (phpBool(options.get('mailing_enabled'))) await q.userSetFlag(userid, FLAGS.NO_MAILINGS, !flag('mailings', !has(FLAGS.NO_MAILINGS)));
        const avatar = body.avatar === undefined ? (has(FLAGS.SHOW_AVATAR) ? 'uploaded' : has(FLAGS.SHOW_GRAVATAR) ? 'gravatar' : '') : String(body.avatar);
        await q.userSetFlag(userid, FLAGS.SHOW_AVATAR, avatar === 'uploaded');
        await q.userSetFlag(userid, FLAGS.SHOW_GRAVATAR, avatar === 'gravatar');

        // The basic filter's filter_profile(); only fields defined in qa_userfields are saved.
        const profile = body.profile ?? {};
        if (typeof profile !== 'object' || Array.isArray(profile)) throw new ApiError(400, 'invalid_input', { profile: 'invalid' });
        for (const { title } of await q.userFields()) {
          if (!Object.hasOwn(profile, title)) continue;
          const value = field(profile, title) ?? '';
          if (text.strlen(value) > MAX.PROFILE) errors[`profile.${title}`] = 'max_length';
          else await q.profileSet(userid, title, value);
        }
      }
      await q.userWritten(userid, ctx.ip); // u_save
      const saved = await q.findAccount(userid);
      return { user: { id: userid, handle: saved.handle, email: saved.email, flags: Number(saved.flags) }, errors };
    }, request);
  }

  // pages/account.php, "Change Password"
  async function changePassword(request) {
    return transaction(async ctx => {
      const { q, account } = ctx;
      const oldPassword = field(request.body, 'oldPassword') ?? '';
      const newPassword = field(request.body, 'newPassword') ?? '';
      const errors = {};
      const haspassword = Boolean(account.passhash) || Boolean(account.passsalt && account.passcheck);
      if (haspassword && !(await verifyPassword(account, oldPassword, saltRounds)).valid) errors.oldPassword = 'wrong';
      const error = passwordError(newPassword);
      if (error) errors.newPassword = error;
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);
      await q.setPasswordHash(account.userid, await bcrypt.hash(newPassword, saltRounds));
      await q.userSet(account.userid, 'sessioncode', ''); // stops PHP's remembered logins
      await q.deleteOtherSessions(account.userid, request.token ? tokenHash(request.token) : null); // keeps this session
      await q.userWritten(account.userid, ctx.ip); // u_password
      return { changed: true };
    }, request);
  }

  // pages/confirm.php, "Send confirmation link"
  async function sendConfirmation(request) {
    return transaction(async ctx => {
      await sendNewConfirm(ctx.q, ctx.options, ctx.account);
      return { sent: true };
    }, request);
  }

  // qa_complete_confirm()
  async function completeConfirm(q, account) {
    await q.userSetFlag(account.userid, FLAGS.EMAIL_CONFIRMED, true);
    await q.userSetFlag(account.userid, FLAGS.MUST_CONFIRM, false);
    await q.userSet(account.userid, 'emailcode', '');
  }

  // pages/confirm.php with a code: matched against the named user, then the signed-in user.
  async function confirmEmail(request) {
    return transaction(async ctx => {
      const { q, account } = ctx;
      const code = (field(request.body, 'code') ?? '').trim();
      const handle = (field(request.body, 'handle') ?? '').trim();
      if (!code.length) throw new ApiError(400, 'validation_failed', { code: 'required' });
      if (handle.length) {
        const named = await q.findAccountByHandle(handle);
        if (named && sameCode(named.emailcode, code)) {
          await completeConfirm(q, named);
          return { confirmed: true };
        }
      }
      if (account) {
        const flags = Number(account.flags);
        if ((flags & FLAGS.EMAIL_CONFIRMED) && !(flags & FLAGS.MUST_CONFIRM)) return { confirmed: true }; // already confirmed
        if (sameCode(account.emailcode, code)) {
          await completeConfirm(q, account);
          return { confirmed: true };
        }
      }
      throw new ApiError(400, 'invalid_code');
    }, { ...request, optional: true });
  }

  // The user named by an email address or handle, as pages/forgot.php and pages/reset.php find it.
  async function matchingUser(q, options, emailHandle, { resetPage }) {
    const byEmail = resetPage ? phpBool(options.get('allow_login_email_only')) || emailHandle.includes('@') : emailHandle.includes('@');
    const ids = await q.findUseridsBy(byEmail ? 'email' : 'handle', emailHandle);
    const allowed = resetPage || byEmail || !phpBool(options.get('allow_login_email_only'));
    return ids.length === 1 && allowed ? ids[0] : null;
  }

  // pages/forgot.php with qa_start_reset_user()
  async function startPasswordReset(request) {
    return transaction(async ctx => {
      const { q, options } = ctx;
      if (ctx.account) throw new ApiError(403, 'already_logged_in');
      const emailHandle = field(request.body, 'emailHandle') ?? '';
      const userid = await matchingUser(q, options, emailHandle, { resetPage: false });
      if (userid === null) throw new ApiError(404, 'user_not_found');
      if (phpBool(options.get('captcha_on_reset_password')) && phpBool(options.get('captcha_module')) &&
        phpBool(options.get('recaptcha_public_key')) && phpBool(options.get('recaptcha_private_key'))) throw new ApiError(400, 'captcha_required');
      const code = text.randomAlphanum(8);
      await q.userSet(userid, 'emailcode', code);
      const account = await q.findAccount(userid);
      const sent = await sendNotification(q, options, {
        userid, email: account.email, handle: account.handle, subject: lang.reset_subject, body: lang.reset_body,
        subs: { '^code': code, '^url': pathAbsolute(options, 'reset', { c: code, e: account.email }) },
      });
      if (!sent) throw new ApiError(503, 'email_failed');
      return { sent: true };
    }, { ...request, optional: true });
  }

  // pages/reset.php with qa_finish_reset_user(): the new password, then a new session.
  async function finishPasswordReset(request) {
    const userid = await transaction(async ctx => {
      const { q, options } = ctx;
      if (ctx.account) throw new ApiError(403, 'already_logged_in');
      const emailHandle = (field(request.body, 'emailHandle') ?? '').trim();
      const code = (field(request.body, 'code') ?? '').trim();
      const newPassword = field(request.body, 'newPassword') ?? '';
      const id = emailHandle.length ? await matchingUser(q, options, emailHandle, { resetPage: true }) : null;
      // The length check matters: an empty code would match every user without one.
      const account = id !== null && code.length ? await q.findAccount(id) : null;
      if (!account || !sameCode(account.emailcode, code)) throw new ApiError(400, 'invalid_code');
      const error = passwordError(newPassword);
      if (error) throw new ApiError(400, 'validation_failed', { newPassword: error });
      await q.setPasswordHash(id, await bcrypt.hash(newPassword, saltRounds));
      await q.userSet(id, 'emailcode', '');
      return id;
    }, { ...request, optional: true });
    return startSession(userid, request.ip);
  }

  // pages/unsubscribe.php: the signed-in user, or the user named in the email link with its code.
  async function unsubscribe(request) {
    return transaction(async ctx => {
      const { q, account } = ctx;
      if (account) {
        await q.userSetFlag(account.userid, FLAGS.NO_MAILINGS, true);
        return { unsubscribed: true };
      }
      const code = (field(request.body, 'code') ?? '').trim();
      const handle = field(request.body, 'handle') ?? '';
      const named = handle ? await q.findAccountByHandle(handle) : null;
      if (!named || !sameCode(named.emailcode, code)) throw new ApiError(400, 'invalid_code');
      await q.userSetFlag(named.userid, FLAGS.NO_MAILINGS, true);
      return { unsubscribed: true };
    }, { ...request, optional: true });
  }

  // pages/account.php avatar upload with qa_set_user_avatar(): resized to avatar_store_size, stored
  // as a JPEG blob, shown instead of a Gravatar, and the previous one deleted.
  async function uploadAvatar(request) {
    const result = await transaction(async ctx => {
      const { q, options, account, actor } = ctx;
      const image = request.image;
      if (!Buffer.isBuffer(image) || !image.length) throw new ApiError(400, 'validation_failed', { image: 'required' });
      const limits = await q.findLimits(account.userid, ctx.ip, LIMIT.UPLOADS);
      const error = userPermitError({ permitoption: null, limitAction: LIMIT.UPLOADS, user: actor, ip: ctx.ip, options, limits });
      if (error === 'limit') throw new ApiError(429, 'upload_limit');
      if (error) throw new ApiError(403, 'no_permission');
      await q.incrementLimits(account.userid, ctx.ip, LIMIT.UPLOADS, ctx.period); // counted before the image is read, as in PHP
      const size = phpNum(options.get('avatar_store_size'));
      let resized;
      try {
        // qa_image_constrain_data(): keep the shape within size × size, white behind transparency, JPEG quality 90.
        const metadata = await sharp(image).metadata();
        let { width, height } = metadata;
        if (width > size || height > size) {
          const multiplier = Math.min(size / width, size / height);
          width = Math.floor(width * multiplier);
          height = Math.floor(height * multiplier);
        }
        const data = await sharp(image).flatten({ background: '#ffffff' }).resize(width, height, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer();
        resized = { data, width, height };
      } catch {
        return { error: 'image_not_read' }; // the upload still counts against the limit
      }
      const blobid = await q.blobCreate(resized.data, 'jpeg', account.userid, ctx.ip);
      if (!blobid) return { error: 'image_not_read' };
      await q.setAvatar(account.userid, blobid, resized.width, resized.height);
      await q.userSetFlag(account.userid, FLAGS.SHOW_AVATAR, true);
      await q.userSetFlag(account.userid, FLAGS.SHOW_GRAVATAR, false);
      if (account.avatarblobid) await q.blobDelete(account.avatarblobid);
      return { avatar: { blobid, width: resized.width, height: resized.height } };
    }, request);
    if (result.error) throw new ApiError(400, result.error);
    return result;
  }

  return { saveProfile, changePassword, sendConfirmation, confirmEmail, startPasswordReset, finishPasswordReset, unsubscribe, uploadAvatar };
}
module.exports = { createAccountService, FLAGS };
