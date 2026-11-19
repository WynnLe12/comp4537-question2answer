const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');

const { cookieName, cookiePath, readToken, requireApiRequest } = require('../../http/cookies');

// Sets the session cookie for a new session, as login and registration do.
function sessionCookie(res, result, secureCookies) {
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: cookiePath };
  res.cookie(cookieName, result.token, { ...cookieOptions, ...(result.remember ? { maxAge: result.ttl * 1000 } : {}) });
}

function authRoutes(service, { secureCookies = false, rateLimitMax = 1000 } = {}) {
  const router = Router();
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: cookiePath };
  const limiter = rateLimit({ windowMs: 3600000, limit: rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'rate_limited' } } });
  router.use(requireApiRequest);
  function establish(res, result, status) {
    res.cookie(cookieName, result.token, { ...cookieOptions, ...(result.remember ? { maxAge: result.ttl * 1000 } : {}) });
    res.status(status).json({ user: result.user });
  }
  router.post('/login', limiter, async (req, res) => establish(res, await service.login(req.body || {}, req.ip), 200));
  router.post('/register', limiter, async (req, res) => establish(res, await service.register(req.body || {}, req.ip), 201));
  router.get('/me', async (req, res) => res.json({ user: await service.me(readToken(req)) }));
  router.post('/logout', async (req, res) => {
    await service.logout(readToken(req));
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  return router;
}
module.exports = { authRoutes, sessionCookie };
