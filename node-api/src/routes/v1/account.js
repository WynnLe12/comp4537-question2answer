const express = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp } = require('../../http/request');
const { sessionCookie } = require('./auth');

// The signed-in user's account (profile, password, avatar), email confirmation, password resets
// and unsubscribing from mailings.
function accountRoutes({ accountService, secureCookies = false }) {
  const router = express.Router();
  // The image itself is the body (PHP's default upload_max_filesize is 2 MB), so this route checks
  // the API request header itself rather than requiring JSON.
  router.put('/avatar', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.get('X-Q2A-Request') !== '1' || !req.is('image/*')) return res.status(403).json({ error: { code: 'request_not_allowed' } });
    next();
  }, express.raw({ type: 'image/*', limit: '2mb' }), async (req, res) => {
    res.json(await accountService.uploadAvatar({ token: readToken(req), ip: clientIp(req.ip), image: Buffer.isBuffer(req.body) ? req.body : null }));
  });
  router.use(requireApiRequest);
  const call = (method, status = 200) => async (req, res) => {
    res.status(status).json(await accountService[method]({ token: readToken(req), ip: clientIp(req.ip), body: req.body }));
  };
  router.patch('/', call('saveProfile'));
  router.put('/password', call('changePassword'));
  router.post('/confirmation-email', call('sendConfirmation'));
  router.post('/confirm-email', call('confirmEmail'));
  router.post('/password-reset', call('startPasswordReset'));
  router.post('/password-reset/complete', async (req, res) => {
    const result = await accountService.finishPasswordReset({ token: readToken(req), ip: clientIp(req.ip), body: req.body });
    sessionCookie(res, result, secureCookies);
    res.json({ user: result.user });
  });
  router.post('/unsubscribe', call('unsubscribe'));
  return router;
}
module.exports = { accountRoutes };
