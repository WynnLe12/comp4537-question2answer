const { createPool } = require('./db');
const { createUserRepository } = require('./repositories/users');
const { createAuthService } = require('./services/auth');
const { createVoteRepository } = require('./repositories/votes');
const { createVoteService } = require('./services/votes');
const { createPostRepository } = require('./repositories/posts');
const { createPostService } = require('./services/posts');
const { createPostChangeService } = require('./services/post-changes');
const { createApp } = require('./app');

async function start() {
  const pool = createPool();
  const service = createAuthService(createUserRepository(pool), {
    jwtSecret: process.env.AUTH_JWT_SECRET,
    saltRounds: Number(process.env.BCRYPT_SALT_ROUNDS ?? 10),
  });
  // Resolves the session cookie to a user, or null for anonymous requests.
  const identify = token => (token ? service.me(token).catch(error => { if (error.status === 401) return null; throw error; }) : null);
  const voteService = createVoteService(createVoteRepository(pool), { identify });
  const postRepository = createPostRepository(pool);
  const postService = createPostService(postRepository, { identify });
  const postChangeService = createPostChangeService(postRepository, { identify });
  const app = createApp({
    service, voteService, postService, postChangeService, health: () => pool.query('SELECT 1'),
    secureCookies: process.env.NODE_ENV === 'production',
    trustProxy: process.env.TRUST_PROXY || false,
  });
  const server = app.listen(3000, '0.0.0.0', () => console.log('Q2A API listening on port 3000'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
start().catch(error => { console.error(error.message); process.exit(1); });
