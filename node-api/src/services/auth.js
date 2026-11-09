// Business rules derived from Q2A pages/login.php, app/users-edit.php and db/users.php.
// See the repository LICENSE and docs/auth-migration.md for supported scope.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const isEmail = require('validator/lib/isEmail');

class AuthError extends Error {
  constructor(status, code, fields) {
    super(code);
    Object.assign(this, { status, code, fields });
  }
}

// qa_post_text trims PHP's ASCII whitespace, including passwords, and normalizes CRLF.
function postText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new AuthError(400, 'invalid_input');
  return value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '').replace(/\r\n?/g, '\n');
}

function registrationInput(body) {
  let handle = postText(body.handle);
  handle = [...handle].filter(c => c.codePointAt(0) <= 0xffff).join('').replace(/\p{C}/gu, '');
  const email = postText(body.email);
  const password = postText(body.password);
  const fields = {};
  if (!handle || ['.', '..'].includes(handle) || /[@+/]/.test(handle) || [...handle].length > 20 || /\banonymous\b/i.test(handle)) fields.handle = 'invalid';
  if (!email || [...email].length > 80 || !isEmail(email, { allow_utf8_local_part: false, allow_ip_domain: true })) fields.email = 'invalid';
  if ([...password].length < 8) fields.password = 'too_short';
  if (Object.keys(fields).length) throw new AuthError(400, 'validation_failed', fields);
  return { handle, email, password };
}

async function verifyPassword(user, password) {
  let legacyValid = false;
  if (user.passsalt && user.passcheck) {
    const salt = Buffer.isBuffer(user.passsalt) ? user.passsalt.toString() : user.passsalt;
    const expected = Buffer.isBuffer(user.passcheck) ? user.passcheck : Buffer.from(user.passcheck, 'hex');
    const actual = createHash('sha1').update(salt.slice(0, 8) + password + salt.slice(8)).digest();
    legacyValid = expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  const modernValid = user.passhash ? await bcrypt.compare(password, user.passhash) : false;
  return { valid: legacyValid || modernValid, rehash: legacyValid || (modernValid && bcrypt.getRounds(user.passhash) !== 10) };
}

const publicUser = user => ({ id: user.userid, handle: user.handle, email: user.email, level: user.level, flags: user.flags });
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const jwtIssuer = 'q2a-node-api';
const jwtAudience = 'q2a-auth';

function createAuthService(repository, { jwtSecret } = {}) {
  if (typeof jwtSecret !== 'string' || Buffer.byteLength(jwtSecret) < 32) {
    throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes');
  }

  function verifiedClaims(token) {
    if (typeof token !== 'string' || token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return null;
    try {
      const claims = jwt.verify(token, jwtSecret, { algorithms: ['HS256'], issuer: jwtIssuer, audience: jwtAudience });
      return /^\d+$/.test(claims.sub) && /^[a-f0-9]{32}$/.test(claims.jti) && Number.isInteger(claims.exp) ? claims : null;
    } catch {
      return null;
    }
  }

  async function session(user, remember, ip) {
    const ttl = remember ? 30 * 86400 : 86400;
    const token = jwt.sign({}, jwtSecret, {
      algorithm: 'HS256', issuer: jwtIssuer, audience: jwtAudience,
      subject: String(user.userid), jwtid: randomBytes(16).toString('hex'), expiresIn: ttl,
    });
    await repository.createSession(user.userid, tokenHash(token), ttl, ip);
    return { user: publicUser(user), token, ttl, remember };
  }
  return {
    async login(body, ip) {
      const identifier = postText(body.emailhandle);
      const password = postText(body.password);
      if (!identifier || !password) throw new AuthError(400, 'validation_failed');
      const users = await repository.find(identifier.includes('@') ? 'email' : 'handle', identifier);
      const user = users.length === 1 ? users[0] : null;
      if (!user) {
        // Avoid returning a different public error for unknown users and wrong passwords.
        await bcrypt.compare(password, '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');
        throw new AuthError(401, 'invalid_credentials');
      }
      const result = await verifyPassword(user, password);
      if (!result.valid) throw new AuthError(401, 'invalid_credentials');
      if (result.rehash) await repository.upgradePassword(user.userid, await bcrypt.hash(password, 10));
      return session(user, body.remember === true, ip);
    },
    async register(body, ip) {
      const input = registrationInput(body);
      const hash = await bcrypt.hash(input.password, 10);
      const user = await repository.createUser({ ...input, hash }, ip);
      return session(user, false, ip);
    },
    async me(token) {
      const claims = verifiedClaims(token);
      const user = claims ? await repository.findSession(tokenHash(token)) : null;
      if (!user || String(user.userid) !== claims.sub) throw new AuthError(401, 'unauthenticated');
      return publicUser(user);
    },
    async logout(token) {
      if (verifiedClaims(token)) await repository.deleteSession(tokenHash(token));
    },
  };
}

module.exports = { AuthError, postText, registrationInput, verifyPassword, createAuthService };
