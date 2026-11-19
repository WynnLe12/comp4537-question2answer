const { Router } = require('express');
const { timingSafeEqual } = require('node:crypto');
const { builders, countSpec } = require('../../reads/selects');
const { runSelect } = require('../../reads/execute');
const { helpers, cacheSet } = require('../../reads/helpers');

// Page reads for the PHP bridge only: { reads: [{ name, args, count }] } names a builder from
// db/selects.php (or a read helper from another db/*.php file) and its arguments; the results are PHP's selectspec results. They include private
// columns (password hashes, emails), so the request must carry the shared bridge key.
function internalRoutes({ pool, bridgeSecret }) {
  const router = Router();
  const secret = Buffer.from(String(bridgeSecret ?? ''));
  router.use((req, res, next) => {
    const given = Buffer.from(String(req.get('X-Q2A-Bridge-Key') ?? ''));
    if (!secret.length || given.length !== secret.length || !timingSafeEqual(given, secret)) return res.status(404).json({ error: { code: 'not_found' } });
    next();
  });
  router.post('/reads', async (req, res) => {
    const reads = req.body?.reads;
    if (!Array.isArray(reads) || reads.length > 100) return res.status(400).json({ error: { code: 'invalid_input' } });
    const connection = await pool.getConnection();
    try {
      const results = [];
      for (const read of reads) {
        const builder = Object.hasOwn(builders, read?.name) ? builders[read.name] : null;
        const helper = Object.hasOwn(helpers, read?.name) ? helpers[read.name] : null;
        if ((!builder && !helper) || !Array.isArray(read.args)) return res.status(400).json({ error: { code: 'invalid_input', fields: { name: String(read?.name) } } });
        try {
          if (helper) {
            results.push(await helper(connection, ...read.args));
          } else {
            let spec = builder(...read.args);
            if (read.count) spec = countSpec(spec);
            results.push(await runSelect(connection, spec));
          }
        } catch (error) {
          error.message = `${read.name}: ${error.message}`;
          throw error;
        }
      }
      res.json({ results });
    } finally {
      connection.release();
    }
  });
  // qa_db_cache_set() for qa-image.php's scaled images: { type, cacheid, content } (content in base64).
  router.post('/cache', async (req, res) => {
    const { type, cacheid, content } = req.body ?? {};
    if (typeof type !== 'string' || !/^\d+$/.test(String(cacheid ?? '')) || typeof content !== 'string') return res.status(400).json({ error: { code: 'invalid_input' } });
    await cacheSet(pool, type, String(cacheid), Buffer.from(content, 'base64'));
    res.status(204).end();
  });
  return router;
}
module.exports = { internalRoutes };
