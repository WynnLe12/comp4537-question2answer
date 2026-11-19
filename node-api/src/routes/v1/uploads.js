const express = require('express');
const { readToken } = require('../../http/cookies');
const { clientIp, readVisitorCookie, setVisitorCookie } = require('../../http/request');

// Files and images added through the editor (app/upload.php). The file itself is the body; its name
// and the caller's limits are query parameters: name, maxSize, onlyImage (1), maxWidth, maxHeight.
function uploadRoutes({ uploadService, secureCookies = false }) {
  const router = express.Router();
  router.post('/', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('X-Q2A-Request') !== '1') return res.status(403).json({ error: { code: 'request_not_allowed' } });
    next();
  }, express.raw({ type: () => true, limit: 16777215 + 1 }), async (req, res) => {
    const query = name => (typeof req.query[name] === 'string' ? req.query[name] : null);
    const { result, cookieid, cookieCreated } = await uploadService.upload({
      token: readToken(req), cookieid: readVisitorCookie(req), ip: clientIp(req.ip),
      content: Buffer.isBuffer(req.body) ? req.body : null, filename: query('name') ?? '',
      maxSize: query('maxSize'), onlyImage: query('onlyImage') === '1', maxWidth: query('maxWidth'), maxHeight: query('maxHeight'),
    });
    if (cookieCreated) setVisitorCookie(res, cookieid, secureCookies);
    if (result.error) return res.status(result.error === 'upload_limit' ? 429 : result.error === 'no_permission' ? 403 : 400)
      .json({ error: { code: result.error, ...(result.maxSize !== undefined ? { maxSize: result.maxSize } : {}) } });
    res.status(201).json({ upload: result });
  });
  return router;
}
module.exports = { uploadRoutes };
