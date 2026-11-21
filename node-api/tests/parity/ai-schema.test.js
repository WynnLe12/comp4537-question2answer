const { createPool } = require('../../src/db');
const { createAiRepository } = require('../../src/repositories/ai');

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

test('aggregates the MySQL usage log without returning individual records', async () => {
  const pool = createPool();
  let connection;
  try {
    connection = await pool.getConnection();
    // Shadow the persistent log for this connection only.
    await connection.query(`CREATE TEMPORARY TABLE node_ai_usage (
      userid INT UNSIGNED NOT NULL,
      evaluation_id BIGINT UNSIGNED NULL,
      endpoint VARCHAR(150) NOT NULL,
      status_code SMALLINT UNSIGNED NOT NULL,
      tokens_used INT UNSIGNED NULL,
      created_at DATETIME NOT NULL
    )`);
    const repository = createAiRepository(connection);
    expect(await repository.getUsageStatistics()).toEqual({
      totalRecordedRequests: 0,
      successfulEvaluations: 0,
      failedProviderAttempts: 0,
      totalRecordedTokens: 0,
      byDate: [],
      byStatus: [],
    });

    const endpoint = '/api/v1/ai/evaluate';
    await connection.query(
      'INSERT INTO node_ai_usage (userid, endpoint, status_code, tokens_used, created_at) VALUES ?',
      [[
        [101, endpoint, 200, 21, '2026-11-20 23:59:59'],
        [102, endpoint, 200, 32, '2026-11-21 00:00:00'],
        [101, endpoint, 200, null, '2026-11-21 00:00:01'],
        [102, endpoint, 429, null, '2026-11-20 23:00:00'],
        [101, endpoint, 429, null, '2026-11-21 04:00:00'],
        [102, endpoint, 502, null, '2026-11-21 05:00:00'],
        [101, '/api/v1/other', 200, 10000, '2026-11-22 00:00:00'],
      ]],
    );
    expect(await repository.getUsageStatistics()).toEqual({
      totalRecordedRequests: 6,
      successfulEvaluations: 3,
      failedProviderAttempts: 3,
      totalRecordedTokens: 53,
      byDate: [{ date: '2026-11-20', requests: 2 }, { date: '2026-11-21', requests: 4 }],
      byStatus: [{ statusCode: 200, requests: 3 }, { statusCode: 429, requests: 2 }, { statusCode: 502, requests: 1 }],
    });
  } finally {
    connection?.release();
    await pool.end();
  }
});
