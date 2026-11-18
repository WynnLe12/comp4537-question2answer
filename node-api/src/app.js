const express = require('express');
const helmet = require('helmet');
const { authRoutes } = require('./routes/v1/auth');
const { postRoutes } = require('./routes/v1/posts');

function createApp({ service, voteService, health = async () => {}, trustProxy = false, ...options }) {
  const app = express();
  app.disable('x-powered-by');
  // The PHP bridge forwards the browser's address in X-Forwarded-For so IP limits and
  // recorded IPs match PHP's REMOTE_ADDR. Only proxies matching TRUST_PROXY are believed.
  app.set('trust proxy', trustProxy);
  app.use(helmet());
  app.use(express.json({ limit: '16kb', strict: true }));
  app.get('/health', async (req, res) => { await health(); res.json({ status: 'ok' }); });
  app.use('/api/v1/auth', authRoutes(service, options));
  if (voteService) app.use('/api/v1/posts', postRoutes(voteService));
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
