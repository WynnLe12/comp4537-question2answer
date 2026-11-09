const { Router } = require('express');
const { rateLimit } = require('express-rate-limit');

const cookieName = 'q2a_node_session';
function readToken(req) {
  const cookies = (req.headers.cookie || '').split(';').map(x => x.trim());
  return cookies.find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

function authRoutes(service, { secureCookies = false, rateLimitMax = 1000 } = {}) {
  const router = Router();
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: secureCookies, path: '/api/v1/auth' };
  const limiter = rateLimit({ windowMs: 3600000, limit: rateLimitMax, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'rate_limited' } } });
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // JSON + a custom header prevents cross-site form submissions. No CORS origins are enabled.
    if (req.method === 'POST' && (req.get('X-Q2A-Request') !== '1' || !req.is('application/json'))) {
      return res.status(403).json({ error: { code: 'request_not_allowed' } });
    }
    next();
  });
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
module.exports = { authRoutes };
