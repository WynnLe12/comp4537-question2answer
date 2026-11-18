// Helpers shared by the v1 resource routes.
const MAX_POSTID = 4294967295; // qa_posts.postid is INT UNSIGNED

// PHP's REMOTE_ADDR shows IPv4 clients as a.b.c.d, not as IPv4-mapped IPv6.
const clientIp = ip => (ip?.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip);

// A post ID from the path, or null when it cannot name a post.
function postIdParam(value) {
  const id = /^\d{1,10}$/.test(value) ? Number(value) : 0;
  return id > 0 && id <= MAX_POSTID ? id : null;
}

// Q2A's anonymous visitor cookie (qa_id), shared with the PHP pages.
const visitorCookie = 'qa_id';
function readVisitorCookie(req) {
  const cookies = (req.headers.cookie || '').split(';').map(x => x.trim());
  return cookies.find(x => x.startsWith(`${visitorCookie}=`))?.slice(visitorCookie.length + 1) ?? null;
}
// qa_cookie_get_create() sets it for a year on the whole site, HttpOnly.
function setVisitorCookie(res, cookieid, secure) {
  if (cookieid) res.cookie(visitorCookie, cookieid, { maxAge: 86400 * 365 * 1000, path: '/', httpOnly: true, secure: Boolean(secure), sameSite: 'lax' });
}

module.exports = { clientIp, postIdParam, readVisitorCookie, setVisitorCookie };
