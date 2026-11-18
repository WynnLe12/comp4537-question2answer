// Port of Q2A's permission and rate-limit checks:
// qa_user_permit_error(), qa_permit_error(), qa_permit_value_error() (app/users.php),
// qa_limits_calc_remaining(), qa_is_ip_blocked() and helpers (app/limits.php).
const net = require('node:net');
const { phpNum, phpBool } = require('./php');

const PERMIT = { ALL: 150, USERS: 120, CONFIRMED: 110, POINTS: 106, POINTS_CONFIRMED: 104, APPROVED: 103, APPROVED_POINTS: 102, EXPERTS: 100, EDITORS: 70, MODERATORS: 40, ADMINS: 20, SUPERS: 0 };
const LEVEL = { BASIC: 0, APPROVED: 10, EXPERT: 20, EDITOR: 50, MODERATOR: 80, ADMIN: 100, SUPER: 120 };
const FLAGS = { EMAIL_CONFIRMED: 1, USER_BLOCKED: 2, MUST_CONFIRM: 128 };
const LIMIT = { QUESTIONS: 'Q', ANSWERS: 'A', COMMENTS: 'C', VOTES: 'V', REGISTRATIONS: 'R', LOGINS: 'L', UPLOADS: 'U', FLAGS: 'F', MESSAGES: 'M', WALL_POSTS: 'W' };
const LIMIT_OPTIONS = {
  Q: ['max_rate_user_qs', 'max_rate_ip_qs'], A: ['max_rate_user_as', 'max_rate_ip_as'], C: ['max_rate_user_cs', 'max_rate_ip_cs'],
  V: ['max_rate_user_votes', 'max_rate_ip_votes'], U: ['max_rate_user_uploads', 'max_rate_ip_uploads'],
  F: ['max_rate_user_flags', 'max_rate_ip_flags'], M: ['max_rate_user_messages', 'max_rate_ip_messages'], W: ['max_rate_user_messages', 'max_rate_ip_messages'],
};

// PHP compares a missing level (null) as 0 in these numeric comparisons.
const lvl = level => (level === null || level === undefined ? 0 : Number(level));

function permitValueError(permit, user, userlevel, options) {
  if (!user && permit < PERMIT.ALL) return 'login';
  const level = lvl(userlevel);
  if ((permit <= PERMIT.SUPERS && level < LEVEL.SUPER) || (permit <= PERMIT.ADMINS && level < LEVEL.ADMIN) ||
    (permit <= PERMIT.MODERATORS && level < LEVEL.MODERATOR) || (permit <= PERMIT.EDITORS && level < LEVEL.EDITOR) ||
    (permit <= PERMIT.EXPERTS && level < LEVEL.EXPERT)) return 'level';
  const flags = user ? Number(user.flags) : 0;
  if (user && (flags & FLAGS.USER_BLOCKED)) return 'userblock';
  if (permit >= PERMIT.USERS) return false;
  if (permit >= PERMIT.CONFIRMED) {
    if (phpBool(options.get('confirm_user_emails')) && level < LEVEL.APPROVED && !(flags & FLAGS.EMAIL_CONFIRMED)) return 'confirm';
  } else if (permit >= PERMIT.APPROVED) {
    if (phpBool(options.get('moderate_users')) && level < LEVEL.APPROVED) return 'approve';
  }
  return false;
}

function permitError(permitoption, user, userlevel, options) {
  let permit = permitoption ? phpNum(options.get(permitoption)) : PERMIT.ALL;
  if (user && [PERMIT.POINTS, PERMIT.POINTS_CONFIRMED, PERMIT.APPROVED_POINTS].includes(permit)) {
    if (Number(user.points) >= phpNum(options.get(`${permitoption}_points`))) {
      permit = permit === PERMIT.APPROVED_POINTS ? PERMIT.APPROVED : permit === PERMIT.POINTS_CONFIRMED ? PERMIT.CONFIRMED : PERMIT.USERS;
    } else {
      permit = PERMIT.EXPERTS; // generic message, as in PHP
    }
  }
  return permitValueError(permit, user, userlevel, options);
}

// qa_limits_calc_remaining(): rows are { period, count } from qa_userlimits / qa_iplimits, or undefined.
function limitsRemaining(action, userLimit, ipLimit, options) {
  const [userOpt, ipOpt] = LIMIT_OPTIONS[action];
  const period = Math.trunc(options.dbTime / 3600);
  const used = row => (row && Number(row.period) === period ? Number(row.count) : 0);
  return Math.max(0, Math.min(phpNum(options.get(userOpt)) - used(userLimit), phpNum(options.get(ipOpt)) - used(ipLimit)));
}

// --- IP blocking (qa_is_ip_blocked and helpers) ---
function ipBytes(ip) {
  if (net.isIPv4(ip)) return ip.split('.').map(Number);
  if (!net.isIPv6(ip)) return null;
  let [head, tail] = ip.includes('::') ? ip.split('::') : [ip, null];
  const part = s => (s ? s.split(':') : []);
  let groups = part(head);
  let rest = tail === null ? [] : part(tail);
  const v4 = arr => (arr.length && arr.at(-1).includes('.') ? arr.pop().split('.').map(Number) : null);
  const v4tail = tail === null ? v4(groups) : v4(rest);
  const extra = v4tail ? 2 : 0;
  if (tail !== null) groups = [...groups, ...Array(8 - groups.length - rest.length - extra).fill('0'), ...rest];
  const bytes = groups.flatMap(g => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
  return v4tail ? [...bytes, ...v4tail] : bytes;
}
function ipv6Expand(ip) {
  const wildcards = [];
  let value = ip;
  if (value.includes('*')) {
    const parts = value.split(':');
    parts.forEach((p, i) => { if (p === '*') { wildcards.push(parts.length - 1 - i); parts[i] = '0'; } });
    value = parts.join(':');
  }
  const bytes = ipBytes(value) || [];
  const groups = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16).padStart(4, '0'));
  for (const index of wildcards) groups[groups.length - 1 - index] = '*';
  return groups.join(':');
}
function ipBetween(ip, start, end) {
  const [u, s, e] = [ipBytes(ip), ipBytes(start), ipBytes(end)];
  if (!u || !s || !e || u.length !== s.length || u.length !== e.length) return false;
  const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  return cmp(u, s) >= 0 && cmp(u, e) <= 0;
}
function blockIpMatch(ip, clause) {
  if (net.isIPv4(ip) && net.isIPv4(clause)) return ip === clause;
  if (!net.isIP(ip)) return false;
  const range = /^(.*)-(.*)$/.exec(clause);
  if (range) return net.isIP(range[1]) && net.isIP(range[2]) ? ipBetween(ip, range[1], range[2]) : false;
  if (!clause.length) return false;
  let [subject, pattern] = [ip, clause];
  if (net.isIPv6(ip)) { subject = ipv6Expand(ip); pattern = ipv6Expand(clause); }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\\\*/g, '([0-9A-Fa-f]+)');
  return new RegExp(`^${escaped}$`).test(subject);
}
function isIpBlocked(ip, options) {
  if (!ip) return false;
  const clauses = String(options.get('block_ips_write') ?? '').replace(/\s*-\s*/g, '-').split(/[^0-9A-Fa-f.:\-*]/).filter(Boolean);
  return clauses.some(clause => blockIpMatch(ip, clause));
}

// qa_user_permit_error(): user is { userid, level, flags, points } or null; userlevel overrides user.level.
function userPermitError({ permitoption, limitAction, userlevel, user, ip, options, limits }) {
  const level = userlevel === undefined || userlevel === null ? user?.level ?? null : userlevel;
  let error = permitError(permitoption, user, level, options);
  if (!error && isIpBlocked(ip, options)) error = 'ipblock';
  if (!error && user && (Number(user.flags) & FLAGS.MUST_CONFIRM) && phpBool(options.get('confirm_user_emails'))) error = 'confirm';
  if (limitAction && !error && limitsRemaining(limitAction, limits?.user, limits?.ip, options) <= 0) error = 'limit';
  return error;
}

// qa_user_level_for_post(): category-specific levels can raise the user's level for that post.
function userLevelForPost(post, user) {
  if (!post.categoryids) return null;
  let level = user?.level ?? null;
  for (const id of String(post.categoryids).split(',')) {
    const categoryLevel = user?.categoryLevels?.get(Number(id));
    if (categoryLevel !== undefined) level = Math.max(lvl(level), categoryLevel);
  }
  return level;
}

module.exports = { PERMIT, LEVEL, FLAGS, LIMIT, permitError, permitValueError, limitsRemaining, isIpBlocked, blockIpMatch, userPermitError, userLevelForPost };
