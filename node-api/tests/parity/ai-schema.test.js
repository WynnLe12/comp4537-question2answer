const { createPool } = require('../../src/db');

test('Compose provisions the AI tables on the Node database', async () => {
  const nodePool = createPool();
  const phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
  const query = `
    SELECT TABLE_NAME AS name
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('node_ai_evaluations', 'node_ai_usage')
    ORDER BY TABLE_NAME`;

  try {
    const [[nodeTables], [phpTables]] = await Promise.all([nodePool.query(query), phpPool.query(query)]);
    expect(nodeTables.map(row => row.name)).toEqual(['node_ai_evaluations', 'node_ai_usage']);
    expect(phpTables).toEqual([]);
  } finally {
    await Promise.all([nodePool.end(), phpPool.end()]);
  }
});
