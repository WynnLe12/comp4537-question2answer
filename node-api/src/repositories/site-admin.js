// SQL for site administration, ported from qa-include/db/options.php, db/admin.php, db/blobs.php and
// the admin pages' other database functions.
const { randomBytes } = require('node:crypto');
const { createTransactor, sharedQueries } = require('./shared');
const { phpNum: phpNumber } = require('../q2a/php');

function createSiteAdminRepository(pool) {
  function queries(db) {
    const shared = sharedQueries(db);
    return {
      ...shared,
      // qa_db_set_option()
      async setOption(name, value) {
        await db.execute('INSERT INTO qa_options (title, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content)', [name, String(value)]);
      },
      async blobCreate(content, format) {
        for (let attempt = 0; attempt < 10; attempt++) {
          const blobid = randomBytes(8).readBigUInt64BE().toString();
          const [[exists]] = await db.execute('SELECT COUNT(*) AS n FROM qa_blobs WHERE blobid=?', [blobid]);
          if (Number(exists.n)) continue;
          await db.execute('INSERT INTO qa_blobs (blobid, format, content, filename, userid, cookieid, createip, created) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NOW())', [blobid, format, content]);
          return blobid;
        }
        return null;
      },
      async blobDelete(blobid) { await db.execute('DELETE FROM qa_blobs WHERE blobid=?', [blobid]); },

      // --- categories (db/admin.php) ---
      async categories() {
        const [rows] = await db.query('SELECT categoryid, parentid, title, tags, content, position FROM qa_categories ORDER BY position FOR UPDATE');
        return rows;
      },
      async categoryLastPos(parentid) {
        const [[row]] = await db.execute('SELECT COALESCE(MAX(position), 0) AS pos FROM qa_categories WHERE parentid<=>?', [parentid]);
        return Number(row.pos);
      },
      async categoryParent(categoryid) {
        const [[row]] = await db.execute('SELECT parentid FROM qa_categories WHERE categoryid=?', [categoryid]);
        return row ? row.parentid : null;
      },
      async categorySlugToId(parentid, slug) {
        const [[row]] = await db.execute('SELECT categoryid FROM qa_categories WHERE parentid<=>? AND tags=?', [parentid, slug]);
        return row ? row.categoryid : null;
      },
      async pageWithSlug(slug) {
        const [[row]] = await db.execute('SELECT pageid FROM qa_pages WHERE tags=?', [slug]);
        return row ?? null;
      },
      // qa_db_categories_recalc_backpaths()
      async categoriesRecalcBackpaths(first, last = first) {
        await db.execute(
          "UPDATE qa_categories AS x, (SELECT cat1.categoryid, CONCAT_WS('/', cat1.tags, cat2.tags, cat3.tags, cat4.tags) AS backpath FROM qa_categories AS cat1 LEFT JOIN qa_categories AS cat2 ON cat1.parentid=cat2.categoryid LEFT JOIN qa_categories AS cat3 ON cat2.parentid=cat3.categoryid LEFT JOIN qa_categories AS cat4 ON cat3.parentid=cat4.categoryid WHERE cat1.categoryid BETWEEN ? AND ?) AS a SET x.backpath=a.backpath WHERE x.categoryid=a.categoryid",
          [first, last]);
      },
      // qa_db_category_create()
      async categoryCreate(parentid, title, tags) {
        const lastpos = await this.categoryLastPos(parentid);
        const [result] = await db.execute('INSERT INTO qa_categories (parentid, title, tags, position) VALUES (?, ?, ?, ?)', [parentid, title, tags, 1 + lastpos]);
        await this.categoriesRecalcBackpaths(result.insertId);
        return result.insertId;
      },
      // qa_db_category_rename()
      async categoryRename(categoryid, title, tags) {
        await db.execute('UPDATE qa_categories SET title=?, tags=? WHERE categoryid=?', [title, tags, categoryid]);
        await this.categoriesRecalcBackpaths(categoryid);
      },
      async categorySetContent(categoryid, content) { await db.execute('UPDATE qa_categories SET content=? WHERE categoryid=?', [content, categoryid]); },
      // qa_db_ordered_move(), without LOCK TABLES (which would end this transaction); the rows are locked instead.
      async orderedMove(table, idcolumn, id, newposition, condition, params) {
        const and = condition ? ` AND ${condition}` : '';
        const [[old]] = await db.query(`SELECT position FROM ${table} WHERE ${idcolumn}=?${and} FOR UPDATE`, [id, ...params]);
        if (!old) return;
        if (String(newposition) !== String(old.position)) {
          const [[last]] = await db.query(`SELECT MAX(position) AS pos FROM ${table} WHERE TRUE${and} FOR UPDATE`, params);
          const position = Math.max(1, Math.min(phpNumber(newposition), Number(last.pos)));
          await db.query(`UPDATE ${table} SET position=? WHERE ${idcolumn}=?${and}`, [1 + Number(last.pos), id, ...params]);
          if (position < old.position) await db.query(`UPDATE ${table} SET position=position+1 WHERE position BETWEEN ? AND ?${and} ORDER BY position DESC`, [position, old.position, ...params]);
          else await db.query(`UPDATE ${table} SET position=position-1 WHERE position BETWEEN ? AND ?${and} ORDER BY position`, [old.position, position, ...params]);
          await db.query(`UPDATE ${table} SET position=? WHERE ${idcolumn}=?${and}`, [position, id, ...params]);
        }
      },
      // qa_db_ordered_delete()
      async orderedDelete(table, idcolumn, id, condition, params) {
        const and = condition ? ` AND ${condition}` : '';
        const [[old]] = await db.query(`SELECT position FROM ${table} WHERE ${idcolumn}=?${and} FOR UPDATE`, [id, ...params]);
        await db.query(`DELETE FROM ${table} WHERE ${idcolumn}=?${and}`, [id, ...params]);
        if (old) await db.query(`UPDATE ${table} SET position=position-1 WHERE position>?${and} ORDER BY position`, [old.position, ...params]);
      },
      // qa_db_category_set_position()
      async categorySetPosition(categoryid, position) {
        await this.orderedMove('qa_categories', 'categoryid', categoryid, position, 'parentid<=>?', [await this.categoryParent(categoryid)]);
      },
      // qa_db_category_set_parent()
      async categorySetParent(categoryid, newparentid) {
        const oldparentid = await this.categoryParent(categoryid);
        if (String(oldparentid ?? '') !== String(newparentid ?? '')) {
          await this.orderedMove('qa_categories', 'categoryid', categoryid, await this.categoryLastPos(oldparentid), 'parentid<=>?', [oldparentid]);
          const lastpos = await this.categoryLastPos(newparentid);
          await db.execute('UPDATE qa_categories SET parentid=?, position=? WHERE categoryid=?', [newparentid, 1 + lastpos, categoryid]);
        }
      },
      // qa_db_category_reassign()
      async categoryReassign(categoryid, reassignid) { await db.execute('UPDATE qa_posts SET categoryid=? WHERE categoryid<=>?', [reassignid, categoryid]); },
      // --- mailings (db/users.php, db/admin.php) ---
      async countUsers() { const [[row]] = await db.query('SELECT COUNT(*) AS n FROM qa_users'); return Number(row.n); },
      // qa_db_users_get_mailing_next()
      async usersMailingNext(lastuserid, count) {
        const [rows] = await db.query('SELECT userid, email, handle, emailcode, flags, level FROM qa_users WHERE userid>? ORDER BY userid LIMIT ?', [lastuserid, count]);
        return rows;
      },
      async userSetEmailcode(userid, code) { await db.execute('UPDATE qa_users SET emailcode=? WHERE userid=?', [code, userid]); },
      async findAccount(userid) {
        const [[row]] = await db.execute('SELECT userid, handle, email, emailcode FROM qa_users WHERE userid=?', [userid]);
        return row;
      },

      // --- custom pages, widgets and user fields (db/admin.php) ---
      async page(pageid) {
        const [[row]] = await db.execute('SELECT pageid, title, flags, permit, nav, tags, position, heading, content FROM qa_pages WHERE pageid=? FOR UPDATE', [pageid]);
        return row;
      },
      async categoryWithBackpath(backpath) {
        const [[row]] = await db.execute('SELECT categoryid FROM qa_categories WHERE backpath=?', [backpath]);
        return row ?? null;
      },
      async pageCreate(title, flags, tags, heading, content, permit) {
        const [[pos]] = await db.query('SELECT 1+COALESCE(MAX(position), 0) AS pos FROM qa_pages FOR UPDATE');
        const [result] = await db.execute("INSERT INTO qa_pages (title, nav, flags, permit, tags, heading, content, position) VALUES (?, '', ?, ?, ?, ?, ?, ?)", [title, flags, permit, tags, heading, content, pos.pos]);
        return result.insertId;
      },
      async pageSetFields(pageid, title, flags, tags, heading, content, permit) {
        await db.execute('UPDATE qa_pages SET title=?, flags=?, permit=?, tags=?, heading=?, content=? WHERE pageid=?', [title, flags, permit, tags, heading, content, pageid]);
      },
      async pageMove(pageid, nav, position) {
        await db.execute('UPDATE qa_pages SET nav=? WHERE pageid=?', [nav, pageid]);
        await this.orderedMove('qa_pages', 'pageid', pageid, position, null, []);
      },
      async pageDelete(pageid) { await this.orderedDelete('qa_pages', 'pageid', pageid, null, []); },
      async widget(widgetid) {
        const [[row]] = await db.execute('SELECT widgetid, place, position, tags, title FROM qa_widgets WHERE widgetid=? FOR UPDATE', [widgetid]);
        return row;
      },
      async widgetCreate(title, tags) {
        const [[pos]] = await db.query('SELECT 1+COALESCE(MAX(position), 0) AS pos FROM qa_widgets FOR UPDATE');
        const [result] = await db.execute("INSERT INTO qa_widgets (place, position, tags, title) VALUES ('', ?, ?, ?)", [pos.pos, tags, title]);
        return result.insertId;
      },
      async widgetSetFields(widgetid, tags) { await db.execute('UPDATE qa_widgets SET tags=? WHERE widgetid=?', [tags, widgetid]); },
      async widgetMove(widgetid, place, position) {
        await db.execute('UPDATE qa_widgets SET place=? WHERE widgetid=?', [place, widgetid]);
        await this.orderedMove('qa_widgets', 'widgetid', widgetid, position, null, []);
      },
      async widgetDelete(widgetid) { await this.orderedDelete('qa_widgets', 'widgetid', widgetid, null, []); },
      async userFields() {
        const [rows] = await db.query('SELECT fieldid, title, content, position, flags, permit FROM qa_userfields ORDER BY position FOR UPDATE');
        return rows;
      },
      async userFieldCreate(title, content, flags, permit) {
        const [[pos]] = await db.query('SELECT 1+COALESCE(MAX(position), 0) AS pos FROM qa_userfields FOR UPDATE');
        const [result] = await db.execute('INSERT INTO qa_userfields (title, content, position, flags, permit) VALUES (?, ?, ?, ?, ?)', [title, content, pos.pos, flags, permit]);
        return result.insertId;
      },
      async userFieldSetFields(fieldid, content, flags, permit) {
        await db.execute('UPDATE qa_userfields SET content=?, flags=?, permit=? WHERE fieldid=?', [content, flags, permit, fieldid]);
      },
      async userFieldMove(fieldid, position) { await this.orderedMove('qa_userfields', 'fieldid', fieldid, position, null, []); },
      async userFieldDelete(fieldid) { await this.orderedDelete('qa_userfields', 'fieldid', fieldid, null, []); },
      // qa_db_category_delete()
      async categoryDelete(categoryid) {
        await this.orderedDelete('qa_categories', 'categoryid', categoryid, 'parentid<=>?', [await this.categoryParent(categoryid)]);
      },
    };
  }
  return { transaction: createTransactor(pool, queries), queries };
}
module.exports = { createSiteAdminRepository };
