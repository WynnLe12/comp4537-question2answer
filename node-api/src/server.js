const { createPool } = require('./db');
const { createUserRepository } = require('./repositories/users');
const { createAuthService } = require('./services/auth');
const { createApp } = require('./app');

async function start() {
  const pool = createPool();
  await pool.query('SELECT 1');
  // This milestone is deliberately bound to the documented local authentication profile.
  const [rows] = await pool.query('SELECT title,content FROM qa_options');
  const options = Object.fromEntries(rows.map(row => [row.title, row.content]));
  const expected = { captcha_on_register: '0', confirm_user_emails: '0', confirm_user_required: '0', show_register_terms: '0', show_notice_welcome: '0', suspend_register_users: '0', allow_login_email_only: '0', points_base: '100', block_bad_usernames: 'anonymous', enabled_plugins: '' };
  for (const [key, value] of Object.entries(expected)) {
    if (options[key] !== value) throw new Error(`Unsupported authentication profile: ${key}`);
  }
  const service = createAuthService(createUserRepository(pool), { jwtSecret: process.env.AUTH_JWT_SECRET });
  const app = createApp({ service, health: () => pool.query('SELECT 1'), secureCookies: process.env.NODE_ENV === 'production' });
  const server = app.listen(3000, '0.0.0.0', () => console.log('Q2A API listening on port 3000'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
start().catch(error => { console.error(error.message); process.exit(1); });
