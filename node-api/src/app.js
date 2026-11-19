const express = require('express');
const helmet = require('helmet');
const { authRoutes } = require('./routes/v1/auth');
const { postRoutes, questionRoutes } = require('./routes/v1/posts');
const { favoriteRoutes } = require('./routes/v1/favorites');
const { userMessageRoutes, wallPostRoutes, privateMessageRoutes } = require('./routes/v1/messages');
const { accountRoutes } = require('./routes/v1/account');
const { feedbackRoutes } = require('./routes/v1/feedback');
const { userAdminRoutes } = require('./routes/v1/user-admin');
const { siteAdminRoutes } = require('./routes/v1/site-admin');
const { internalRoutes } = require('./routes/v1/internal');

function createApp({ service, voteService, postService, postChangeService, favoriteService, messageService, accountService, feedbackService, userAdminService, siteAdminService, recalcService, readPool, bridgeSecret, health = async () => {}, trustProxy = false, ...options }) {
  const app = express();
  app.disable('x-powered-by');
  // The PHP bridge forwards the browser's address in X-Forwarded-For so IP limits and
  // recorded IPs match PHP's REMOTE_ADDR. Only proxies matching TRUST_PROXY are believed.
  app.set('trust proxy', trustProxy);
  app.use(helmet());
  // Posts may hold 12000 characters (up to 36 kB of UTF-8); everything else stays small.
  app.use('/api/v1/internal', express.json({ limit: '2mb', strict: true }));
  app.use(['/api/v1/questions', '/api/v1/posts', '/api/v1/users', '/api/v1/admin'], express.json({ limit: '64kb', strict: true }));
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/health', async (req, res) => { await health(); res.json({ status: 'ok' }); });
  app.use('/api/v1/auth', authRoutes(service, options));
  if (voteService || postService || postChangeService) app.use('/api/v1/posts', postRoutes({ voteService, postService, postChangeService, secureCookies: options.secureCookies }));
  if (postService) app.use('/api/v1/questions', questionRoutes({ postService, postChangeService, secureCookies: options.secureCookies }));
  if (favoriteService) app.use('/api/v1/favorites', favoriteRoutes({ favoriteService }));
  if (messageService) {
    app.use('/api/v1/users', userMessageRoutes({ messageService }));
    app.use('/api/v1/wall-posts', wallPostRoutes({ messageService }));
    app.use('/api/v1/messages', privateMessageRoutes({ messageService }));
  }
  if (accountService) app.use('/api/v1/account', accountRoutes({ accountService, secureCookies: options.secureCookies }));
  if (feedbackService) app.use('/api/v1/feedback', feedbackRoutes({ feedbackService }));
  if (userAdminService) app.use('/api/v1/users', userAdminRoutes({ userAdminService }));
  if (siteAdminService) app.use('/api/v1/admin', siteAdminRoutes({ siteAdminService, recalcService }));
  if (readPool) app.use('/api/v1/internal', internalRoutes({ pool: readPool, bridgeSecret }));
  app.get(['/demo', '/demo/'], (req, res) => res.redirect('http://localhost:8081/?qa=login'));
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found' } }));
  app.use((error, req, res, next) => {
    const known = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
    const status = known ? error.status : 503;
    if (!known && error.type === undefined && process.env.NODE_ENV !== 'test') console.error(error);
    const code = error.type === 'entity.parse.failed' ? 'invalid_json' : error.type === 'entity.too.large' ? 'payload_too_large' : known ? error.code : 'service_unavailable';
    res.status(status).json({ error: { code, ...(known && error.fields ? { fields: error.fields } : {}) } });
  });
  return app;
}
module.exports = { createApp };
