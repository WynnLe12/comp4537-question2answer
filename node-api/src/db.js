const mysql = require('mysql2/promise');

function createPool(overrides = {}) {
  return mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    user: process.env.DB_USER || 'q2a',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'q2a',
    connectionLimit: 10,
    charset: 'utf8mb4',
    timezone: 'Z',
    ...overrides,
  });
}
module.exports = { createPool };
