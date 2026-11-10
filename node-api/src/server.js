const { createPool } = require('./db');
const { createUserRepository } = require('./repositories/users');
const { createAuthService } = require('./services/auth');
const { createApp } = require('./app');

async function start() {
  const pool = createPool();
  const service = createAuthService(createUserRepository(pool), { jwtSecret: process.env.AUTH_JWT_SECRET });
  const app = createApp({ service, health: () => pool.query('SELECT 1'), secureCookies: process.env.NODE_ENV === 'production' });
  const server = app.listen(3000, '0.0.0.0', () => console.log('Q2A API listening on port 3000'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
start().catch(error => { console.error(error.message); process.exit(1); });
