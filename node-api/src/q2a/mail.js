// Port of qa_send_notification() and qa_send_email() (qa-include/app/emails.php). Email goes out
// through the SMTP server in Q2A's options (smtp_active, smtp_address, smtp_port, smtp_secure,
// smtp_authenticate, smtp_username, smtp_password), as PHPMailer sends it.
const nodemailer = require('nodemailer');
const { phpBool } = require('./php');
const { emailValidate } = require('./text');
const lang = require('../data/lang-emails.json');

const transports = new Map();
function transportFor(options) {
  const config = {
    host: options.get('smtp_address'), port: Number(options.get('smtp_port')),
    secure: options.get('smtp_secure') === 'ssl', requireTLS: options.get('smtp_secure') === 'tls',
    // Without smtp_secure PHPMailer accepts any certificate the server offers.
    tls: options.get('smtp_secure') ? undefined : { rejectUnauthorized: false },
    auth: phpBool(options.get('smtp_authenticate')) ? { user: options.get('smtp_username'), pass: options.get('smtp_password') } : undefined,
  };
  const key = JSON.stringify(config);
  if (!transports.has(key)) transports.set(key, nodemailer.createTransport(config));
  return transports.get(key);
}

// qa_send_email(): returns whether the email was sent.
async function sendEmail(options, { fromemail, fromname, toemail, toname, replytoemail = null, replytoname = null, subject, body, html = false }) {
  // Without SMTP PHPMailer uses PHP's mail(); Node has no local mailer to hand it to.
  if (!phpBool(options.get('smtp_active'))) return false;
  // PHPMailer's encodeString() normalizes line breaks and ends the body with one; createBody()
  // then adds another.
  body = String(body).replace(/\r\n?/g, '\n');
  if (!body.endsWith('\n')) body += '\n';
  body += '\n';
  try {
    await transportFor(options).sendMail({
      from: { name: fromname, address: fromemail }, sender: fromemail, envelope: { from: fromemail, to: toemail },
      to: { name: toname ?? '', address: toemail }, subject, [html ? 'html' : 'text']: body,
      ...(replytoemail ? { replyTo: { name: replytoname ?? '', address: replytoemail } } : {}),
    });
    return true;
  } catch (error) {
    console.error('Question2Answer email send error:', error.message);
    return false;
  }
}

// qa_send_notification(): fills in the user's email and handle when missing, adds the standard
// substitutions and the "handle," greeting, and sends it.
async function sendNotification(q, options, args) {
  const email = await prepareNotification(q, options, args);
  return email ? sendEmail(options, email) : false;
}
// The same, built inside the transaction and sent once it commits; the result is not waited for,
// as PHP's event modules ignore it.
async function queueNotification(q, options, args) {
  const email = await prepareNotification(q, options, args);
  if (email) q.afterCommit.push(() => sendEmail(options, email));
}
function queueEmail(q, options, params) {
  q.afterCommit.push(() => sendEmail(options, params));
}

async function prepareNotification(q, options, { userid = null, email = null, handle = null, subject, body, subs = {}, html = false }) {
  if (userid !== null && (!emailValidate(email ?? '') || !handle)) {
    const account = await q.findUserEmailHandle(userid);
    if (!handle) handle = account?.handle ?? null;
    if (!emailValidate(email ?? '')) email = account?.email ?? null;
  }
  if (!email || !emailValidate(email)) return null;
  const all = { ...subs, '^site_title': options.get('site_title'), '^site_url': options.get('site_url'), '^handle': handle ?? '', '^email': email, '^open': '\n', '^close': '\n' };
  return {
    fromemail: options.get('from_email'), fromname: options.get('site_title'), toemail: email, toname: handle,
    subject: strtr(subject, all), body: (handle ? lang.to_handle_prefix.split('^').join(handle) : '') + strtr(body, all), html,
  };
}

// PHP's strtr() with an array: longest keys first, each position replaced once.
function strtr(value, subs) {
  const keys = Object.keys(subs).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!keys.length) return value;
  const pattern = new RegExp(keys.map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return String(value).replace(pattern, match => String(subs[match] ?? ''));
}

module.exports = { sendEmail, sendNotification, prepareNotification, queueNotification, queueEmail, strtr, lang };
