const { AuthError } = require('../services/auth');

function createUserRepository(pool) {
  return {
    async find(field, value) {
      if (!['email', 'handle'].includes(field)) throw new Error('Invalid lookup field');
      const [rows] = await pool.execute(`SELECT * FROM qa_users WHERE ${field} = ?`, [value]);
      return rows;
    },
    async upgradePassword(id, hash) {
      await pool.execute('UPDATE qa_users SET passhash=?, passsalt=NULL, passcheck=NULL WHERE userid=?', [hash, id]);
    },
    async createUser(input, ip) {
      const connection = await pool.getConnection();
      let locked = false;
      try {
        // Q2A has non-unique handle/email indexes. Serialize API registrations without changing its schema.
        const [[lock]] = await connection.query("SELECT GET_LOCK('node_auth_register', 10) AS acquired");
        locked = lock.acquired === 1;
        if (!locked) throw new AuthError(503, 'registration_busy');
        await connection.beginTransaction();
        const fields = {};
        for (const field of ['handle', 'email']) {
          const [existing] = await connection.execute(`SELECT userid FROM qa_users WHERE ${field}=?`, [input[field]]);
          if (existing.length) fields[field] = 'exists';
        }
        if (Object.keys(fields).length) throw new AuthError(409, 'validation_failed', fields);
        const [result] = await connection.execute(
          'INSERT INTO qa_users (created,createip,email,handle,passhash,level,loggedin,loginip,flags) VALUES (UTC_TIMESTAMP(),INET6_ATON(?),?,?,?,0,UTC_TIMESTAMP(),INET6_ATON(?),0)',
          [ip, input.email, input.handle, input.hash, ip],
        );
        await connection.execute('INSERT INTO qa_userpoints (userid,points) VALUES (?,100)', [result.insertId]);
        for (const name of ['cache_userpointscount', 'cache_uapprovecount']) {
          const query = name === 'cache_userpointscount' ? 'SELECT COUNT(*) AS total FROM qa_userpoints' : 'SELECT COUNT(*) AS total FROM qa_users WHERE level<10 AND NOT(flags & 2)';
          const [[{ total }]] = await connection.query(query);
          await connection.execute('INSERT INTO qa_options (title,content) VALUES (?,?) ON DUPLICATE KEY UPDATE content=?', [name, String(total), String(total)]);
        }
        await connection.commit();
        return { userid: result.insertId, handle: input.handle, email: input.email, level: 0, flags: 0 };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        if (locked) await connection.query("SELECT RELEASE_LOCK('node_auth_register')");
        connection.release();
      }
    },
    async createSession(id, hash, ttl, ip) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM node_auth_sessions WHERE expires_at <= UTC_TIMESTAMP()');
        await connection.execute('INSERT INTO node_auth_sessions (token_hash,userid,expires_at) VALUES (?,?,TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP()))', [hash, id, ttl]);
        await connection.execute('UPDATE qa_users SET loggedin=UTC_TIMESTAMP(),loginip=INET6_ATON(?) WHERE userid=?', [ip, id]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally { connection.release(); }
    },
    async findSession(hash) {
      const [rows] = await pool.execute('SELECT u.* FROM node_auth_sessions s JOIN qa_users u ON u.userid=s.userid WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP()', [hash]);
      return rows[0];
    },
    async deleteSession(hash) {
      await pool.execute('DELETE FROM node_auth_sessions WHERE token_hash=?', [hash]);
    },
  };
}
module.exports = { createUserRepository };
