// SQL for editor uploads (app/upload.php): rate limits, the visitor cookie and the blob itself.
const { randomBytes } = require('node:crypto');
const { createTransactor, sharedQueries } = require('./shared');

function createUploadRepository(pool) {
  function queries(db) {
    return {
      ...sharedQueries(db),

      // qa_cookie_get_create() / qa_db_cookie_create()
      async cookieExists(cookieid) {
        const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM qa_cookies WHERE cookieid=?', [cookieid]);
        return Number(n) > 0;
      },
      async createCookie(ip) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const cookieid = randomBytes(8).readBigUInt64BE().toString(); // qa_db_random_bigint()
          if (await this.cookieExists(cookieid)) continue;
          await db.query('INSERT INTO qa_cookies (cookieid, created, createip) VALUES (?, NOW(), INET6_ATON(?))', [cookieid, ip]);
          return cookieid;
        }
        return null;
      },

      // qa_create_blob() / qa_db_blob_create(): blobs are kept in the database (no QA_BLOBS_DIRECTORY).
      async blobCreate({ content, format, filename, userid, cookieid, ip }) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const blobid = randomBytes(8).readBigUInt64BE().toString();
          const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM qa_blobs WHERE blobid=?', [blobid]);
          if (Number(n)) continue;
          await db.query(
            'INSERT INTO qa_blobs (blobid, format, content, filename, userid, cookieid, createip, created) VALUES (?, ?, ?, ?, ?, ?, INET6_ATON(?), NOW())',
            [blobid, format, content, filename, userid, cookieid, ip]);
          return blobid;
        }
        return null;
      },
    };
  }
  return { transaction: createTransactor(pool, queries), queries };
}

module.exports = { createUploadRepository };
