const express = require('express');
const helmet = require('helmet');
const { authRoutes } = require('./routes/v1/auth');
const { postRoutes, questionRoutes } = require('./routes/v1/posts');
const { favoriteRoutes } = require('./routes/v1/favorites');

function createApp({ service, voteService, postService, postChangeService, favoriteService, health = async () => {}, trustProxy = false, ...options }) {
  const app = express();
  app.disable('x-powered-by');
  // The PHP bridge forwards the browser's address in X-Forwarded-For so IP limits and
  // recorded IPs match PHP's REMOTE_ADDR. Only proxies matching TRUST_PROXY are believed.
  app.set('trust proxy', trustProxy);
  app.use(helmet());
  // Posts may hold 12000 characters (up to 36 kB of UTF-8); everything else stays small.
  app.use(['/api/v1/questions', '/api/v1/posts'], express.json({ limit: '64kb', strict: true }));
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/health', async (req, res) => { await health(); res.json({ status: 'ok' }); });
  app.use('/api/v1/auth', authRoutes(service, options));
  if (voteService || postService || postChangeService) app.use('/api/v1/posts', postRoutes({ voteService, postService, postChangeService, secureCookies: options.secureCookies }));
  if (postService) app.use('/api/v1/questions', questionRoutes({ postService, postChangeService, secureCookies: options.secureCookies }));
  if (favoriteService) app.use('/api/v1/favorites', favoriteRoutes({ favoriteService }));
  app.get(['/demo', '/demo/'], (req, res) => res.redirect('http://localhost:8081/?qa=login'));
  app.use((req, res) => res.status(404).json({ error: { code: 'not_found' } }));
  app.use((error, req, res, next) => {
    const known = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
    const status = known ? error.status : 503;
    const code = error.type === 'entity.parse.failed' ? 'invalid_json' : error.type === 'entity.too.large' ? 'payload_too_large' : known ? error.code : 'service_unavailable';
    res.status(status).json({ error: { code, ...(known && error.fields ? { fields: error.fields } : {}) } });
  });
  return app;
}
module.exports = { createApp };
