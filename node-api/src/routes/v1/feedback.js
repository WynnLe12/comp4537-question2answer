const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp } = require('../../http/request');

// The feedback form. `browser` defaults to the request's User-Agent (the bridge passes the visitor's).
function feedbackRoutes({ feedbackService }) {
  const router = Router();
  router.use(requireApiRequest);
  router.post('/', async (req, res) => {
    const browser = typeof req.body?.browser === 'string' ? req.body.browser : req.get('User-Agent');
    res.json(await feedbackService.sendFeedback({ token: readToken(req), ip: clientIp(req.ip), body: req.body, browser }));
  });
  return router;
}
module.exports = { feedbackRoutes };
