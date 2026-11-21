const { AuthError } = require('../services/auth');
const { loadOptions } = require('../q2a/options');
const { phpBool } = require('../q2a/php');
const { prepareNotification, strtr, lang } = require('../q2a/mail');
const { pathAbsolute } = require('../q2a/paths');
const { randomAlphanum } = require('../q2a/text');
const strings = require('../data/lang-strings.json');

const FLAGS = { WELCOME_NOTICE: 64, MUST_CONFIRM: 128 };

function createUserRepository(pool) {
  return {
    async find(field, value) {
      if (!['email', 'handle'].includes(field)) throw new Error('Invalid lookup field');
      const [rows] = await pool.execute(`SELECT * FROM qa_users WHERE ${field} = ?`, [value]);
      return rows;
    },
    async findById(id) {
      const [[user]] = await pool.execute('SELECT * FROM qa_users WHERE userid = ?', [id]);
      return user;
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
        // The rest of qa_create_new_user(): the welcome notice, the confirmation code, and the emails,
        // which are sent once the account is committed.
        const userid = result.insertId;
        const options = await loadOptions(connection);
        let flags = 0;
        if (phpBool(options.get('show_notice_welcome'))) flags |= FLAGS.WELCOME_NOTICE;
        let confirm = '';
        if (phpBool(options.get('confirm_user_emails'))) { // level is always QA_USER_LEVEL_BASIC here
          const code = randomAlphanum(8);
          await connection.execute('UPDATE qa_users SET emailcode=? WHERE userid=?', [code, userid]);
          confirm = strtr(lang.welcome_confirm, { '^url': pathAbsolute(options, 'confirm', { c: code, u: input.handle }) });
          if (phpBool(options.get('confirm_user_required'))) flags |= FLAGS.MUST_CONFIRM;
        }
        if (flags) await connection.execute('UPDATE qa_users SET flags=flags|? WHERE userid=?', [flags, userid]);
        const custom = phpBool(options.get('show_custom_welcome')) ? String(options.get('custom_welcome') ?? '').trim() : '';
        const lookup = { findUserEmailHandle: async () => ({ email: input.email, handle: input.handle }) };
        const emails = [await prepareNotification(lookup, options, {
          userid, email: input.email, handle: input.handle, subject: lang.welcome_subject, body: lang.welcome_body,
          subs: { '^password': strings['main/hidden'], '^url': options.get('site_url'), '^custom': custom.length ? `${custom}\n\n` : '', '^confirm': confirm },
        })];
        if (phpBool(options.get('register_notify_admin'))) { // qa_event_notify, u_register
          emails.push(await prepareNotification(lookup, options, {
            userid: null, email: options.get('feedback_email'), handle: null, subject: lang.u_registered_subject,
            body: phpBool(options.get('moderate_users')) ? lang.u_to_approve_body : lang.u_registered_body,
            subs: { '^u_handle': input.handle, '^url': pathAbsolute(options, `user/${input.handle}`), '^a_url': pathAbsolute(options, 'admin/approve') },
          }));
        }
        await connection.commit();
        return { userid, handle: input.handle, email: input.email, level: 0, flags, emails: emails.filter(Boolean), options };
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        if (locked) await connection.query("SELECT RELEASE_LOCK('node_auth_register')");
        connection.release();
      }
    },
    async createSession(id, hash, ttl, ip) {
      // Release the expiry-index gap locks before starting the session write transaction.
      await pool.execute('DELETE FROM node_auth_sessions WHERE expires_at <= UTC_TIMESTAMP()');
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
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
