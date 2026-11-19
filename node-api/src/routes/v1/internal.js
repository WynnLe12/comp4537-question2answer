const { Router } = require('express');
const { timingSafeEqual } = require('node:crypto');
const { builders, countSpec } = require('../../reads/selects');
const { runSelect } = require('../../reads/execute');

// Page reads for the PHP bridge only: { reads: [{ name, args, count }] } names a builder from
// db/selects.php and its arguments; the results are PHP's selectspec results. They include private
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
        if (!builder || !Array.isArray(read.args)) return res.status(400).json({ error: { code: 'invalid_input', fields: { name: String(read?.name) } } });
        try {
          let spec = builder(...read.args);
          if (read.count) spec = countSpec(spec);
          results.push(await runSelect(connection, spec));
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
  return router;
}
module.exports = { internalRoutes };
