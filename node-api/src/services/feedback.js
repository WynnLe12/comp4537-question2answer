// The feedback form (pages/feedback.php) with qa_send_feedback() (app/emails.php): the visitor's
// message emailed to the site's feedback address.
const { ApiError } = require('../errors');
const { phpBool } = require('../q2a/php');
const { userPermitError } = require('../q2a/permissions');
const text = require('../q2a/text');
const { sendEmail, strtr, lang } = require('../q2a/mail');
const { pathAbsolute } = require('../q2a/paths');

function field(body, name) {
  const value = body?.[name];
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, 'invalid_input', { [name]: 'invalid' });
  return text.postText(value) ?? '';
}

function createFeedbackService(repository, { identify }) {
  async function sendFeedback({ token, ip, body, browser }) {
    const identity = await identify(token);
    const prepared = await repository.transaction(async q => {
      const options = await q.loadOptions();
      if (!phpBool(options.get('feedback_enabled'))) throw new ApiError(404, 'not_found');
      const user = identity ? await q.findActor(identity.id) : null;
      if (userPermitError({ permitoption: null, user, ip, options })) throw new ApiError(403, 'no_permission');
      const message = field(body, 'message');
      const name = field(body, 'name');
      const email = field(body, 'email');
      const referer = field(body, 'referer');
      // PHP's empty(): "0" counts as empty too.
      if (message === '' || message === '0') throw new ApiError(400, 'validation_failed', { message: 'required' });
      if (phpBool(options.get('captcha_on_feedback')) && (!user || Number(user.level) < 10) && phpBool(options.get('captcha_module')) &&
        phpBool(options.get('recaptcha_public_key')) && phpBool(options.get('recaptcha_private_key'))) throw new ApiError(400, 'captcha_required');
      const empty = value => value === '' || value === '0';
      const subs = {
        '^message': message, '^name': empty(name) ? '-' : name, '^email': empty(email) ? '-' : email, '^previous': empty(referer) ? '-' : referer,
        '^url': user ? pathAbsolute(options, `user/${user.handle}`) : '-', '^ip': ip, '^browser': browser ?? '',
      };
      return {
        options,
        email: {
          fromemail: options.get('from_email'), fromname: name, replytoemail: text.emailValidate(email) ? email : null, replytoname: name,
          toemail: options.get('feedback_email'), toname: options.get('site_title'),
          subject: lang.feedback_subject.split('^').join(options.get('site_title')), body: strtr(lang.feedback_body, subs),
        },
      };
    });
    const sent = await sendEmail(prepared.options, prepared.email);
    if (!sent) throw new ApiError(503, 'email_failed');
    return { sent: true };
  }
  return { sendFeedback };
}
module.exports = { createFeedbackService };
