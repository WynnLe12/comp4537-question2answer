const cookieName = 'q2a_node_session';
// Scoped to every v1 resource (auth, posts, ...) so direct API clients send it beyond /auth.
const cookiePath = '/api/v1';

function readToken(req) {
  const cookies = (req.headers.cookie || '').split(';').map(x => x.trim());
  return cookies.find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

// JSON + a custom header prevents cross-site form submissions. No CORS origins are enabled.
function requireApiRequest(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD' && (req.get('X-Q2A-Request') !== '1' || !req.is('application/json'))) {
    return res.status(403).json({ error: { code: 'request_not_allowed' } });
  }
  next();
}

module.exports = { cookieName, cookiePath, readToken, requireApiRequest };
