// Shared by the posting and post-change parity suites: drivers for the original pages, the shared
// UI and the API, identical fixture posts, and a snapshot of everything Q2A writes for posts.
const request = require('supertest');
const cheerio = require('cheerio');

const PHP_URL = process.env.PHP_URL || 'http://localhost:8080';
const UI_URL = process.env.MIGRATED_UI_URL || 'http://localhost:8081';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const clean = value => value.replace(/\s+/g, ' ').trim();

// Messages a Q2A page shows: the page error plus any field errors, in page order.
function pageMessages(html) {
  const $ = cheerio.load(html);
  return $('.qa-error, .qa-form-tall-error, .qa-form-wide-error').map((i, el) => clean($(el).text())).get().filter(Boolean).join(' | ');
}

// The fields a browser would submit for a form: inputs, checked boxes, textareas and selections.
function formFields($, form) {
  const fields = {};
  form.find('input, textarea, select').each((i, el) => {
    const field = $(el);
    const name = field.attr('name');
    const type = (field.attr('type') || '').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'reset'].includes(type)) return;
    if (type === 'checkbox' || type === 'radio') { if (field.attr('checked') !== undefined) fields[name] = field.attr('value') ?? 'on'; return; }
    if (el.tagName === 'select') { fields[name] = field.find('option[selected]').attr('value') ?? field.find('option').first().attr('value') ?? ''; return; }
    fields[name] = el.tagName === 'textarea' ? field.text() : (field.attr('value') ?? '');
  });
  return fields;
}

// Drives the original pages exactly as a browser submits them (the editor fields included).
function siteDriver(name, baseUrl, pool) {
  const client = request.agent(baseUrl);
  // Question pages redirect to their canonical URL, and a POST to any other URL is redirected unprocessed.
  async function questionPage(questionid, state) {
    // The redirect to the canonical URL drops other parameters, so find that URL first.
    const first = await client.get(`/index.php?qa=${questionid}`).redirects(3);
    const url = new URL(first.redirects.at(-1) ?? `${baseUrl}/index.php?qa=${questionid}`);
    const path = url.pathname + url.search;
    const page = state ? await client.get(`${path}&state=${state}`) : first;
    return { $: cheerio.load(page.text), path };
  }
  function outcome(response, idPattern) {
    if (response.status === 302) {
      const id = idPattern.exec(response.headers.location ?? '');
      return { accepted: true, id: id ? Number(id[1] ?? id[2]) : null, backend: response.headers['x-q2a-post-backend'] };
    }
    return { accepted: false, message: pageMessages(response.text) };
  }
  return {
    name, pool,
    _client: client,
    _get: path => client.get(path).redirects(3),
    async register(handle) {
      const page = await client.get('/?qa=register').expect(200);
      const code = cheerio.load(page.text)('[name=doregister]').closest('form').find('[name=code]').val();
      const response = await client.post('/?qa=register').type('form')
        .send({ handle, email: `${handle}@example.test`, password: 'Password123!', code, doregister: '1' });
      expect(response.status).toBe(302);
    },
    async ask(input) {
      const path = `/index.php?qa=ask${input.followAnswerId ? `&follow=${input.followAnswerId}` : ''}`;
      const page = await client.get(path).expect(200);
      const code = cheerio.load(page.text)('[name=doask]').closest('form').find('[name=code]').val() ?? 'none';
      const form = {
        title: input.title, content: input.content, content_ckeditor_ok: input.format === 'html' ? '1' : '0',
        editor: 'WYSIWYG Editor', tags: input.tags ?? '', name: input.name ?? '', email: input.email ?? '', code, doask: '1',
      };
      if (input.notify) form.notify = '1';
      return outcome(await client.post(path).type('form').send(form), /qa=(\d+)|^\.?\/?(\d+)\//);
    },
    async answer(questionid, input) {
      const { $, path } = await questionPage(questionid, 'answer');
      const code = $('[name=a_doadd]').closest('form').find('[name=code]').val() ?? 'none';
      const form = { a_content: input.content, a_content_ckeditor_ok: '0', a_editor: 'WYSIWYG Editor', a_name: input.name ?? '', a_email: input.email ?? '', code, a_doadd: '1' };
      if (input.notify) form.a_notify = '1';
      return outcome(await client.post(path).type('form').send(form), /show=(\d+)/);
    },
    // Opens a post's edit form, changes the given fields and saves it, as a browser would.
    async edit(questionid, postid, kind, changes) {
      const { $, path } = await questionPage(questionid, `edit-${postid}`);
      const prefix = kind === 'Q' ? 'q_' : `${kind.toLowerCase()}${postid}_`;
      const save = $(`[name=${prefix}dosave]`);
      if (!save.length) return { accepted: false, message: pageMessages($.html()) };
      const fields = formFields($, save.closest('form'));
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === false) delete fields[prefix + key]; else fields[prefix + key] = value === true ? '1' : String(value);
      }
      if (`${prefix}content_ckeditor_ok` in fields) fields[`${prefix}content_ckeditor_ok`] = '0'; // plain text, as with JavaScript off
      const response = await client.post(path).type('form').send(fields);
      return response.status === 302
        ? { accepted: true, id: postid, backend: response.headers['x-q2a-post-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // Clicks one of a post's buttons (select, hide, reshow, approve, reject, delete, claim, reopen).
    async act(questionid, postid, kind, action) {
      const { $, path } = await questionPage(questionid);
      const name = kind === 'Q' ? `q_do${action}` : `${kind.toLowerCase()}${postid}_do${action}`;
      const button = $(`[name=${name}]`);
      if (!button.length) return { accepted: false, message: '' };
      const fields = { ...formFields($, button.closest('form')), [name]: '1' };
      const response = await client.post(path).type('form').send(fields);
      return response.status === 302
        ? { accepted: true, id: postid, backend: response.headers['x-q2a-post-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // Presses the favorite button on a page (a question, a user profile or a tag page).
    async favorite(page, entitytype, entityid, favorite) {
      const path = typeof page === 'number' ? (await questionPage(page)).path : page;
      const $ = cheerio.load((await client.get(path).redirects(3)).text);
      const name = `favorite_${entitytype}_${entityid}_${favorite ? 1 : 0}`;
      const button = $(`[name=${name}]`);
      if (!button.length) return { accepted: false, message: '' };
      const response = await client.post(path).type('form').send({ ...formFields($, button.closest('form')), [name]: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-favorite-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // Private messages: the message page form (pages/message.php).
    async sendMessage(handle, message) {
      const path = `/index.php?qa=message/${encodeURIComponent(handle)}`;
      const $ = cheerio.load((await client.get(path)).text);
      const form = $('[name=domessage]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post(path).type('form').send({ ...formFields($, form), message, domessage: '1' });
      if (response.status === 302) return { accepted: true, backend: response.headers['x-q2a-message-backend'] };
      // Q2A's error pages answer 200: qa_fatal_error() and, for a failed query, the install page.
      if (response.status >= 500 || /Question2Answer fatal error|A Question2Answer database query failed/.test(response.text)) return { accepted: false, message: 'server error' };
      // Without message history there is no redirect: the page shows the form again, with no error.
      const sent = cheerio.load(response.text)('.qa-form-tall-ok').length > 0 || !pageMessages(response.text);
      return sent ? { accepted: true, backend: response.headers['x-q2a-message-backend'] } : { accepted: false, message: pageMessages(response.text) };
    },
    // Wall posts: the form on the user's wall page (pages/user-wall.php).
    async wallPost(handle, message) {
      const path = `/index.php?qa=user/${encodeURIComponent(handle)}/wall`;
      const $ = cheerio.load((await client.get(path)).text);
      const form = $('[name=dowallpost]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post(path).type('form').send({ ...formFields($, form), message, dowallpost: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-message-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // The delete button on a wall post, without JavaScript.
    async deleteWallPost(handle, messageid) {
      const path = `/index.php?qa=user/${encodeURIComponent(handle)}/wall`;
      const $ = cheerio.load((await client.get(path)).text);
      const name = `m${messageid}_dodelete`;
      const button = $(`[name=${name}]`);
      if (!button.length) return { accepted: false, message: '' };
      const response = await client.post(path).type('form').send({ ...formFields($, button.closest('form')), [name]: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-message-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // The same wall delete button with JavaScript on: qa_wall_post_click() posts to ajax/click-wall.php.
    async deleteWallPostAjax(handle, messageid) {
      const $ = cheerio.load((await client.get(`/index.php?qa=user/${encodeURIComponent(handle)}/wall`)).text);
      const name = `m${messageid}_dodelete`;
      if (!$(`[name=${name}]`).length) return { accepted: false, message: '' };
      const form = $('form[name=wallpost]');
      const response = await client.post('/index.php').type('form').send({
        messageid: String(messageid), handle: form.find('[name=handle]').val(), start: form.find('[name=start]').val(), code: form.find('[name=code]').val(),
        [name]: '1', qa: 'ajax', qa_operation: 'click_wall', qa_root: './', qa_request: `user/${handle}/wall`,
      });
      return /QA_AJAX_RESPONSE\s+1/.test(response.text)
        ? { accepted: true, backend: response.headers['x-q2a-message-backend'] }
        : { accepted: false, message: '' };
    },
    // The delete button in the inbox or outbox, which only works through ajax (qa_pm_click()).
    async deleteMessage(box, messageid) {
      const $ = cheerio.load((await client.get(`/index.php?qa=${box === 'inbox' ? 'messages' : 'messages/sent'}`)).text);
      const name = `m${messageid}_dodelete`;
      if (!$(`[name=${name}]`).length) return { accepted: false, message: '' };
      const form = $('form[name=pmessage]');
      const response = await client.post('/index.php').type('form').send({
        messageid: String(messageid), box, handle: form.find('[name=handle]').val(), start: form.find('[name=start]').val(), code: form.find('[name=code]').val(),
        [name]: '1', qa: 'ajax', qa_operation: 'click_pm', qa_root: './', qa_request: box === 'inbox' ? 'messages' : 'messages/sent',
      });
      return /QA_AJAX_RESPONSE\s+1/.test(response.text)
        ? { accepted: true, backend: response.headers['x-q2a-message-backend'] }
        : { accepted: false, message: '' };
    },
    // --- account pages ---
    // The account page's profile form. changes: handle, email, messages, wallPosts, mailings
    // (booleans for the checkboxes), avatar ('', 'gravatar', 'uploaded') and profile { title: value }.
    async saveProfile(changes, image = null) {
      const $ = cheerio.load((await client.get('/index.php?qa=account')).text);
      const form = $('[name=dosaveprofile]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const fields = { ...formFields($, form), dosaveprofile: '1' };
      for (const [key, name] of [['handle', 'handle'], ['email', 'email'], ['avatar', 'avatar']]) if (changes[key] !== undefined) fields[name] = changes[key];
      for (const [key, name] of [['messages', 'messages'], ['wallPosts', 'wall'], ['mailings', 'mailings']]) {
        if (changes[key] === true) fields[name] = '1';
        if (changes[key] === false) delete fields[name];
      }
      if (changes.profile) {
        const [rows] = await pool.query('SELECT fieldid, title FROM qa_userfields');
        for (const row of rows) if (changes.profile[row.title] !== undefined) fields[`field_${row.fieldid}`] = changes.profile[row.title];
      }
      let call = client.post('/index.php?qa=account');
      if (image) {
        for (const [key, value] of Object.entries(fields)) call = call.field(key, value);
        call = call.attach('file', image, 'avatar.png');
      } else call = call.type('form').send(fields);
      const response = await call;
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    async uploadAvatar(image) { return this.saveProfile({}, image); },
    async changePassword(oldPassword, newPassword, repeat = newPassword) {
      const $ = cheerio.load((await client.get('/index.php?qa=account')).text);
      const form = $('[name=dochangepassword]').closest('form');
      const response = await client.post('/index.php?qa=account').type('form')
        .send({ ...formFields($, form), oldpassword: oldPassword, newpassword1: newPassword, newpassword2: repeat, dochangepassword: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // The confirm page's "send link" button, for a signed-in user.
    async sendConfirmation() {
      const $ = cheerio.load((await client.get('/index.php?qa=confirm')).text);
      const form = $('[name=dosendconfirm]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post('/index.php?qa=confirm').type('form').send({ ...formFields($, form), dosendconfirm: '1' });
      return cheerio.load(response.text)('.qa-success').length
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // Following the link in the confirmation email.
    async confirmEmail(handle, code) {
      const response = await client.get(`/index.php?qa=confirm&c=${encodeURIComponent(code)}&u=${encodeURIComponent(handle)}`);
      return cheerio.load(response.text)('.qa-success').length
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    async forgotPassword(emailHandle) {
      const $ = cheerio.load((await client.get('/index.php?qa=forgot')).text);
      const form = $('[name=doforgot]').closest('form');
      const response = await client.post('/index.php?qa=forgot').type('form').send({ ...formFields($, form), emailhandle: emailHandle, doforgot: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // Following the link in the reset email, then choosing a new password.
    async resetPassword(emailHandle, code, newPassword) {
      const path = `/index.php?qa=reset&e=${encodeURIComponent(emailHandle)}&c=${encodeURIComponent(code)}`;
      const $ = cheerio.load((await client.get(path)).text);
      const form = $('[name=dochangepassword]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post(path).type('form')
        .send({ ...formFields($, form), newpassword1: newPassword, newpassword2: newPassword, dochangepassword: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    async unsubscribe(handle = null, code = null) {
      const path = handle ? `/index.php?qa=unsubscribe&c=${encodeURIComponent(code)}&u=${encodeURIComponent(handle)}` : '/index.php?qa=unsubscribe';
      const $ = cheerio.load((await client.get(path)).text);
      const form = $('[name=dounsubscribe]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post(path).type('form').send({ ...formFields($, form), dounsubscribe: '1' });
      return cheerio.load(response.text)('.qa-success').length
        ? { accepted: true, backend: response.headers['x-q2a-account-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // The feedback form.
    async feedback({ message, name = '', email = '' }) {
      const $ = cheerio.load((await client.get('/index.php?qa=feedback')).text);
      const form = $('[name=dofeedback]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post('/index.php?qa=feedback').type('form').send({ ...formFields($, form), message, name, email, dofeedback: '1' });
      const $result = cheerio.load(response.text);
      return $result('.qa-form-tall-ok').length
        ? { accepted: true, backend: response.headers['x-q2a-feedback-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // --- user administration ---
    // A button on a user's profile page (doapprove, doblock, dounblock, dohideall, dodelete).
    async userButton(handle, name) {
      const path = `/index.php?qa=user/${encodeURIComponent(handle)}`;
      const $ = cheerio.load((await client.get(path)).text);
      const button = $(`[name=${name}]`);
      if (!button.length) return { accepted: false, message: '' };
      const response = await client.post(path).type('form').send({ ...formFields($, button.closest('form')), [name]: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] ?? response.headers['x-q2a-post-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // The profile page's admin edit form: email, profile { title: value }, level, removeAvatar.
    async adminEditUser(handle, changes) {
      const path = `/index.php?qa=user/${encodeURIComponent(handle)}`;
      const $ = cheerio.load((await client.get(`${path}&state=edit`)).text);
      const form = $('[name=dosave]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const fields = { ...formFields($, form), dosave: '1' };
      if (changes.email !== undefined) fields.email = changes.email;
      if (changes.level !== undefined) fields.level = String(changes.level);
      if (changes.removeAvatar) fields.removeavatar = '1';
      if (changes.profile) {
        const [rows] = await pool.query('SELECT fieldid, title FROM qa_userfields');
        for (const row of rows) if (changes.profile[row.title] !== undefined) fields[`field_${row.fieldid}`] = changes.profile[row.title];
      }
      const response = await client.post(path).type('form').send(fields);
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // A button on an admin page (admin/moderate, admin/flagged, admin/hidden, admin/approve).
    async adminClick(page, entityid, action) {
      const path = `/index.php?qa=admin/${page}`;
      const $ = cheerio.load((await client.get(path)).text);
      const name = `admin_${entityid}_${action}`;
      const button = $(`[name=${name}]`);
      if (!button.length) return { accepted: false, message: '' };
      const response = await client.post(path).type('form').send({ ...formFields($, button.closest('form')), [name]: '1' });
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] ?? response.headers['x-q2a-post-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // --- site administration ---
    // An admin options page (admin/<section>): changes { name: value } (true/false for checkboxes), saved
    // or reset with the page's own button.
    async adminView(section) { await client.get(`/index.php?qa=admin/${section}`); },
    // admin/points: change point values and press "Save and recalculate" (without JavaScript it
    // then sends you on to the recalculation page).
    async adminPoints(changes) {
      const $ = cheerio.load((await client.get('/index.php?qa=admin/points')).text);
      const form = $('form[name=points_form]');
      const fields = { ...formFields($, form), dosaverecalc: '1', has_js: '0' };
      for (const [name, value] of Object.entries(changes)) fields[`option_${name}`] = String(value);
      const response = await client.post('/index.php?qa=admin/points').type('form').send(fields);
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // admin/plugins: enable exactly these plugin directories (the page's script sends their hashes).
    async adminPlugins(directories) {
      const { createHash } = require('node:crypto');
      const $ = cheerio.load((await client.get('/index.php?qa=admin/plugins')).text);
      const form = $('form[name=plugins_form]');
      const fields = { ...formFields($, form), dosave: '1', enabled_plugins_hashes: directories.map(d => createHash('md5').update(d).digest('hex')).join(';') };
      const response = await client.post('/index.php?qa=admin/plugins').type('form').send(fields);
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // A recalculation tool, run the way the stats page's buttons run it (ajax/recalc.php, a few
    // seconds at a time) until it finishes.
    async recalc(operation) {
      const $ = cheerio.load((await client.get('/index.php?qa=admin/stats')).text);
      const code = $(`[name=${operation}]`).closest('form').find('[name=code]').val();
      if (!code) return { accepted: false, message: pageMessages($.html()) };
      let state = operation;
      let backend;
      for (let calls = 0; state && calls < 5000; calls++) {
        const response = await client.post('/index.php').type('form').send({ state, code, qa: 'ajax', qa_operation: 'recalc', qa_root: './', qa_request: 'admin/stats' });
        backend ??= response.headers['x-q2a-admin-backend'];
        const lines = response.text.slice(response.text.indexOf('QA_AJAX_RESPONSE')).split('\n');
        if (lines[1] !== '1') return { accepted: false, message: lines.slice(2).join(' ') };
        state = lines[2] ?? '';
      }
      return { accepted: true, backend };
    },
    // A form on an admin page: GET path (or press reveal on it first), set changes (false unchecks a
    // box; position 'last' picks the last position option, starting with positionPrefix), and press submit.
    async adminForm({ path, reveal = null, submit, changes = {}, positionPrefix = '' }) {
      const fullPath = `/index.php?qa=${path}`;
      let $ = cheerio.load((await client.get(fullPath)).text);
      if (reveal) {
        const button = $(`[name=${reveal}]`);
        if (!button.length) return { accepted: false, message: pageMessages($.html()) };
        $ = cheerio.load((await client.post(fullPath).type('form').send({ ...formFields($, button.closest('form')), [reveal]: '1' })).text);
      }
      const control = $(`[name=${submit}]`);
      if (!control.length) return { accepted: false, message: pageMessages($.html()) };
      const form = control.closest('form');
      const fields = { ...formFields($, form), [submit]: '1' };
      for (const [name, value] of Object.entries(changes)) {
        if (value === false) delete fields[name];
        else if (name === 'position' && value === 'last') {
          const values = form.find('[name=position] option').map((i, o) => $(o).attr('value')).get().filter(v => String(v).startsWith(positionPrefix));
          fields.position = values.at(-1);
        } else fields[name] = value === true ? '1' : String(value);
      }
      const response = await client.post(fullPath).type('form').send(fields);
      // Some admin pages redirect after saving; others show their list again, without the form.
      const saved = response.status === 302 || (!pageMessages(response.text) && !cheerio.load(response.text)(`[name=${submit}]`).length);
      return saved
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // admin/categories: add a category (top level, or under parentid), edit one, or delete one.
    async adminCategorySave({ categoryid = null, parentid = null, name, slug, content, deleteIt = false }) {
      let path = '/index.php?qa=admin/categories';
      let $;
      if (categoryid !== null) {
        path += `&edit=${categoryid}`;
        $ = cheerio.load((await client.get(path)).text);
      } else if (parentid !== null) {
        path += `&edit=${parentid}&addsub=${parentid}`;
        $ = cheerio.load((await client.get(path)).text);
      } else {
        const list = cheerio.load((await client.get(path)).text);
        const addForm = list('[name=doaddcategory]').closest('form');
        $ = cheerio.load((await client.post(path).type('form').send({ ...formFields(list, addForm), doaddcategory: '1' })).text);
      }
      const form = $('[name=dosavecategory]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const fields = { ...formFields($, form), dosavecategory: '1' };
      if (name !== undefined) fields.name = name;
      if (slug !== undefined) fields.slug = slug;
      if (content !== undefined) fields.content = content;
      if (deleteIt) fields.dodelete = '1';
      const response = await client.post(path).type('form').send(fields);
      return response.status === 302
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    async adminOptions(section, changes, button = 'dosaveoptions') {
      const path = `/index.php?qa=admin/${section}`;
      const $ = cheerio.load((await client.get(path)).text);
      const form = $('form[name=admin_form]');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const fields = { ...formFields($, form), [button]: '1' };
      for (const [name, value] of Object.entries(changes)) {
        if (value === false) delete fields[`option_${name}`];
        else fields[`option_${name}`] = value === true ? '1' : String(value);
      }
      const response = await client.post(path).type('form').send(fields);
      const $result = cheerio.load(response.text);
      return $result('.qa-form-tall-ok, .qa-form-wide-ok').length
        ? { accepted: true, backend: response.headers['x-q2a-admin-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    // Whether this browser is signed in (the page shows a logout link).
    async signedIn() {
      return cheerio.load((await client.get('/index.php?qa=account').redirects(0).ok(() => true)).text)('[name=dosaveprofile]').length > 0;
    },
    // The same button with JavaScript on: qa_favorite_click() posts to ajax/favorite.php.
    async favoriteAjax(page, entitytype, entityid, favorite) {
      const $ = cheerio.load((await client.get(page).redirects(3)).text);
      const button = $(`[name=favorite_${entitytype}_${entityid}_${favorite ? 1 : 0}]`);
      if (!button.length) return { accepted: false, message: '' };
      const response = await client.post('/index.php').type('form').send({
        entitytype, entityid: String(entityid), favorite: favorite ? '1' : '0', code: button.closest('form').find('[name=code]').val(),
        qa: 'ajax', qa_operation: 'favorite', qa_root: './', qa_request: new URL(page, baseUrl).searchParams.get('qa') ?? '',
      });
      return /QA_AJAX_RESPONSE\s+1/.test(response.text)
        ? { accepted: true, backend: response.headers['x-q2a-favorite-backend'] }
        : { accepted: false, message: response.text.split('\n').slice(2).join(' ').trim() };
    },
    async close(questionid, details) {
      const { $, path } = await questionPage(questionid, 'close');
      const form = $('[name=doclose]').closest('form');
      if (!form.length) return { accepted: false, message: pageMessages($.html()) };
      const response = await client.post(path).type('form').send({ ...formFields($, form), q_close_details: details });
      return response.status === 302
        ? { accepted: true, id: questionid, backend: response.headers['x-q2a-post-backend'] }
        : { accepted: false, message: pageMessages(response.text) };
    },
    async comment(questionid, parentid, input) {
      const { $, path } = await questionPage(questionid, `comment-${parentid}`);
      const prefix = `c${parentid}_`;
      const form = {
        [`${prefix}content`]: input.content, [`${prefix}editor`]: '', [`${prefix}name`]: input.name ?? '', [`${prefix}email`]: input.email ?? '',
        [`${prefix}code`]: $(`[name=${prefix}code]`).val() ?? 'none', [`${prefix}doadd`]: '1',
      };
      if (input.notify) form[`${prefix}notify`] = '1';
      return outcome(await client.post(path).type('form').send(form), /show=(\d+)/);
    },
  };
}

function apiDriver(pool) {
  const client = request.agent(API_URL);
  const send = async (path, body) => {
    const response = await client.post(path).set('X-Q2A-Request', '1').send(body);
    return response.status === 201
      ? { accepted: true, id: response.body.id }
      : { accepted: false, status: response.status, code: response.body.error?.code, fields: response.body.error?.fields };
  };
  const accepted = (response, status = 200) => (response.status === status
    ? { accepted: true, id: response.body.id ?? null }
    : { accepted: false, status: response.status, code: response.body.error?.code, fields: response.body.error?.fields });
  const common = input => ({ content: input.content, format: input.format ?? '', notify: Boolean(input.notify), email: input.email ?? '', name: input.name ?? '' });
  return {
    name: 'node-api', pool,
    _client: client,
    async register(handle) {
      await client.post('/api/v1/auth/register').set('X-Q2A-Request', '1')
        .send({ handle, email: `${handle}@example.test`, password: 'Password123!' }).expect(201);
    },
    ask: input => send('/api/v1/questions', { ...common(input), title: input.title, tags: input.tags ?? '', followAnswerId: input.followAnswerId }),
    answer: (questionid, input) => send(`/api/v1/questions/${questionid}/answers`, common(input)),
    comment: (questionid, parentid, input) => send(`/api/v1/posts/${parentid}/comments`, common(input)),
    async act(questionid, postid, kind, action) {
      const call = {
        select: () => client.put(`/api/v1/questions/${questionid}/selected-answer`).send({ answerId: postid }),
        unselect: () => client.put(`/api/v1/questions/${questionid}/selected-answer`).send({ answerId: null }),
        reopen: () => client.delete(`/api/v1/questions/${questionid}/close`).send({}),
        delete: () => client.delete(`/api/v1/posts/${postid}`).send({}),
        claim: () => client.post(`/api/v1/posts/${postid}/claim`).send({}),
        flag: () => client.put(`/api/v1/posts/${postid}/flag`).send({}),
        unflag: () => client.delete(`/api/v1/posts/${postid}/flag`).send({}),
        clearflags: () => client.delete(`/api/v1/posts/${postid}/flags`).send({}),
      }[action] ?? (() => client.post(`/api/v1/posts/${postid}/status`).send({ action }));
      const response = await call().set('X-Q2A-Request', '1');
      return response.status === 200
        ? { accepted: true, id: postid }
        : { accepted: false, status: response.status, code: response.body.error?.code, fields: response.body.error?.fields };
    },
    // --- account ---
    async saveProfile(changes) {
      const response = await client.patch('/api/v1/account').set('X-Q2A-Request', '1').send(changes);
      if (response.status !== 200) return { accepted: false, status: response.status, code: response.body.error?.code };
      return Object.keys(response.body.errors).length ? { accepted: false, status: 200, errors: response.body.errors } : { accepted: true };
    },
    async uploadAvatar(image) {
      return accepted(await client.put('/api/v1/account/avatar').set('X-Q2A-Request', '1').set('Content-Type', 'image/png').send(image));
    },
    async changePassword(oldPassword, newPassword) {
      return accepted(await client.put('/api/v1/account/password').set('X-Q2A-Request', '1').send({ oldPassword, newPassword }));
    },
    async sendConfirmation() { return accepted(await client.post('/api/v1/account/confirmation-email').set('X-Q2A-Request', '1').send({})); },
    async confirmEmail(handle, code) { return accepted(await client.post('/api/v1/account/confirm-email').set('X-Q2A-Request', '1').send({ handle, code })); },
    async forgotPassword(emailHandle) { return accepted(await client.post('/api/v1/account/password-reset').set('X-Q2A-Request', '1').send({ emailHandle })); },
    async resetPassword(emailHandle, code, newPassword) {
      return accepted(await client.post('/api/v1/account/password-reset/complete').set('X-Q2A-Request', '1').send({ emailHandle, code, newPassword }));
    },
    async unsubscribe(handle = null, code = null) {
      return accepted(await client.post('/api/v1/account/unsubscribe').set('X-Q2A-Request', '1').send(handle ? { handle, code } : {}));
    },
    async signedIn() { return (await client.get('/api/v1/auth/me')).status === 200; },
    async userButton(handle, name) {
      const base = `/api/v1/users/${encodeURIComponent(handle)}`;
      const call = {
        doapprove: () => client.post(`${base}/approve`), doblock: () => client.put(`${base}/block`), dounblock: () => client.delete(`${base}/block`),
        dohideall: () => client.post(`${base}/hide-posts`), dodelete: () => client.delete(base),
      }[name];
      return accepted(await call().set('X-Q2A-Request', '1').send({}));
    },
    async adminEditUser(handle, changes) {
      const base = `/api/v1/users/${encodeURIComponent(handle)}`;
      const { level, ...rest } = changes;
      const edit = await client.patch(base).set('X-Q2A-Request', '1').send(rest);
      if (edit.status !== 200) return { accepted: false, status: edit.status, code: edit.body.error?.code };
      if (level !== undefined) {
        const changed = await client.put(`${base}/level`).set('X-Q2A-Request', '1').send({ level });
        if (changed.status !== 200) return { accepted: false, status: changed.status, code: changed.body.error?.code };
      }
      return Object.keys(edit.body.errors).length ? { accepted: false, errors: edit.body.errors } : { accepted: true };
    },
    async adminClick(page, entityid, action, handle = null) {
      const call = {
        approve: () => client.post(`/api/v1/posts/${entityid}/status`).send({ action: 'approve' }),
        reject: () => client.post(`/api/v1/posts/${entityid}/status`).send({ action: 'reject' }),
        hide: () => client.post(`/api/v1/posts/${entityid}/status`).send({ action: 'hide' }),
        reshow: () => client.post(`/api/v1/posts/${entityid}/status`).send({ action: 'reshow' }),
        delete: () => client.delete(`/api/v1/posts/${entityid}`).send({}),
        clearflags: () => client.delete(`/api/v1/posts/${entityid}/flags`).send({}),
        userapprove: () => client.post(`/api/v1/users/${encodeURIComponent(handle)}/approve`).send({}),
        userblock: () => client.put(`/api/v1/users/${encodeURIComponent(handle)}/block`).send({}),
      }[action];
      return accepted(await call().set('X-Q2A-Request', '1'));
    },
    async adminView() {},
    async adminPoints(changes) {
      return accepted(await client.put('/api/v1/admin/options').set('X-Q2A-Request', '1').send({ values: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, String(v)])) }));
    },
    async adminPlugins(directories) {
      return accepted(await client.put('/api/v1/admin/plugins').set('X-Q2A-Request', '1').send({ directories }));
    },
    async recalc(operation) {
      let state = operation;
      for (let calls = 0; state && calls < 5000; calls++) {
        const response = await client.post('/api/v1/admin/recalc').set('X-Q2A-Request', '1').send({ state, seconds: 3 });
        if (response.status !== 200) return { accepted: false, status: response.status, code: response.body.error?.code };
        state = response.body.state;
      }
      return { accepted: true };
    },
    // The same operations through the API: method and path under /api/v1/admin, and the body.
    async adminApi(method, path, body = {}) {
      const response = await client[method](`/api/v1/admin/${path}`).set('X-Q2A-Request', '1').send(body);
      // Saves that keep going past a failed field report it in `errors`, like the admin pages.
      if (response.status === 200 && response.body.errors && Object.keys(response.body.errors).length) return { accepted: false, errors: response.body.errors };
      return accepted(response);
    },
    async adminCategorySave({ categoryid = null, parentid = null, name, slug, content, deleteIt = false }) {
      if (deleteIt) return accepted(await client.delete(`/api/v1/admin/categories/${categoryid}`).set('X-Q2A-Request', '1').send({}));
      const body = { name, slug, content: content ?? '', parentid };
      return accepted(categoryid !== null
        ? await client.put(`/api/v1/admin/categories/${categoryid}`).set('X-Q2A-Request', '1').send(body)
        : await client.post('/api/v1/admin/categories').set('X-Q2A-Request', '1').send(body));
    },
    async adminOptions(section, changes, button = 'dosaveoptions', names = null) {
      if (button === 'doresetoptions') return accepted(await client.post('/api/v1/admin/options/reset').set('X-Q2A-Request', '1').send({ names, site: { host: 'localhost:8080' } }));
      const values = Object.fromEntries(Object.entries(changes).map(([name, value]) => [name, value === true ? '1' : value === false ? null : String(value)]));
      return accepted(await client.put('/api/v1/admin/options').set('X-Q2A-Request', '1').send({ values }));
    },
    async feedback({ message, name = '', email = '' }) {
      return accepted(await client.post('/api/v1/feedback').set('X-Q2A-Request', '1').send({ message, name, email, referer: '' }));
    },
    async sendMessage(handle, message) {
      return accepted(await client.post(`/api/v1/users/${encodeURIComponent(handle)}/messages`).set('X-Q2A-Request', '1').send({ content: message }), 201);
    },
    async wallPost(handle, message) {
      return accepted(await client.post(`/api/v1/users/${encodeURIComponent(handle)}/wall`).set('X-Q2A-Request', '1').send({ content: message }), 201);
    },
    async deleteWallPost(handle, messageid) {
      return accepted(await client.delete(`/api/v1/wall-posts/${messageid}`).set('X-Q2A-Request', '1').send({}));
    },
    async deleteMessage(box, messageid) {
      return accepted(await client.delete(`/api/v1/messages/${box}/${messageid}`).set('X-Q2A-Request', '1').send({}));
    },
    async favorite(page, entitytype, entityid, favorite) {
      const type = { Q: 'questions', U: 'users', T: 'tags', C: 'categories' }[entitytype];
      const response = await client[favorite ? 'put' : 'delete'](`/api/v1/favorites/${type}/${entityid}`).set('X-Q2A-Request', '1').send({});
      return response.status === 200
        ? { accepted: true }
        : { accepted: false, status: response.status, code: response.body.error?.code };
    },
    async close(questionid, details) {
      const response = await client.post(`/api/v1/questions/${questionid}/close`).set('X-Q2A-Request', '1').send({ details });
      return response.status === 200
        ? { accepted: true, id: questionid }
        : { accepted: false, status: response.status, code: response.body.error?.code, fields: response.body.error?.fields };
    },
    // The API edit takes the same changes as the form; fields left out keep their values.
    async edit(questionid, postid, kind, changes) {
      const body = {};
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'dotoc') continue;
        body[key === 'commenton' ? 'convertToCommentOn' : key] = key === 'commenton' ? Number(value) : value;
      }
      const response = await client.patch(`/api/v1/posts/${postid}`).set('X-Q2A-Request', '1').send(body);
      return response.status === 200
        ? { accepted: true, id: postid, type: response.body.type }
        : { accepted: false, status: response.status, code: response.body.error?.code, fields: response.body.error?.fields };
    },
  };
}

// Identical fixture posts in each database. Fixed timestamps keep them comparable.
async function createFixtures(pool, handles, token) {
  const users = {};
  for (const [label, handle] of Object.entries(handles)) {
    const [[row]] = await pool.execute('SELECT userid FROM qa_users WHERE handle=?', [handle]);
    users[label] = row.userid;
  }
  const insert = async (type, parentid, userid, created, title, content, acount = 0) => {
    const [result] = await pool.execute(
      "INSERT INTO qa_posts (type,parentid,userid,created,title,content,format,tags,acount) VALUES (?,?,?,?,?,?,'','',?)",
      [type, parentid, userid, created, title, content, acount]);
    return result.insertId;
  };
  const ids = {};
  ids.q = await insert('Q', null, users.owner, '2026-02-01 10:00:00', `Fixture question ${token} about caching`, 'How should I cache rendered pages?');
  ids.qa = await insert('Q', null, users.owner, '2026-02-01 11:00:00', `Answered fixture ${token} question`, 'Which database index helps here?', 1);
  ids.a = await insert('A', ids.qa, users.owner, '2026-02-01 12:00:00', null, 'Add a composite index on the filtered columns.');
  ids.c1 = await insert('C', ids.a, users.other, '2026-02-01 13:00:00', null, 'Would a covering index be better here?');
  ids.hidden = await insert('Q_HIDDEN', null, users.owner, '2026-02-01 10:00:00', `Hidden fixture ${token} question`, 'Hidden body text');
  // Give the fixture questions the hotness Q2A would have computed; the site drivers' page views
  // recompute it anyway, and the API driver never views a page.
  await pool.query(
    "UPDATE qa_posts p LEFT JOIN (SELECT parentid, COUNT(*) AS n, MAX(created) AS last FROM qa_posts WHERE type='A' GROUP BY parentid) a ON a.parentid=p.postid " +
    'SET p.hotness = ((TO_DAYS(p.created)-734138)*86400.0+TIME_TO_SEC(p.created))*100 + ((TO_DAYS(COALESCE(a.last,p.created))-734138)*86400.0+TIME_TO_SEC(COALESCE(a.last,p.created)))*100 ' +
    '+ COALESCE(a.n,0)*100*160000 + p.netvotes*100*160000 + p.views*100*4000 WHERE p.postid IN (?)', [[ids.q, ids.qa, ids.hidden]]);
  // Q2A keeps these totals consistent as posts are created; recount them for the new fixtures.
  for (const [key, where] of [
    ['cache_qcount', "type='Q'"], ['cache_acount', "type='A'"], ['cache_ccount', "type='C'"],
    ['cache_unaqcount', "type='Q' AND acount=0 AND closedbyid IS NULL"], ['cache_unselqcount', "type='Q' AND selchildid IS NULL AND closedbyid IS NULL"],
    ['cache_unupaqcount', "type='Q' AND amaxvote=0 AND closedbyid IS NULL"], ['cache_queuedcount', "type IN ('Q_QUEUED','A_QUEUED','C_QUEUED')"],
  ]) {
    await pool.query(`INSERT INTO qa_options (title,content) SELECT ?, COUNT(*) FROM qa_posts WHERE ${where} ON DUPLICATE KEY UPDATE content=VALUES(content)`, [key]);
  }
  return { ids, users };
}

// Rate-limit rows, keyed by user or IP, with their hourly period. Q2A starts the count again when
// the period changes, so a change is the new count after a new hour and the difference otherwise.
async function limitRows(pool, sql, params) {
  const [rows] = await pool.query(sql, params);
  return Object.fromEntries(rows.map(row => [String(row.k), { period: Number(row.period), count: Number(row.count) }]));
}
function limitDelta(before, after) {
  let delta = 0;
  for (const [key, row] of Object.entries(after)) {
    const old = before[key];
    delta += old && old.period === row.period ? row.count - old.count : row.count;
  }
  return delta;
}

const CACHES = ['cache_qcount', 'cache_acount', 'cache_ccount', 'cache_unaqcount', 'cache_unselqcount', 'cache_unupaqcount', 'cache_queuedcount', 'cache_userpointscount', 'cache_flaggedcount'];

// Everything the create functions write, with IDs replaced by labels and the per-backend token masked.
async function snapshot(backend, newId, focusId = newId) {
  const { pool } = backend.actor;
  const { ids, users, token } = backend;
  const postLabel = new Map(Object.entries(ids).map(([label, id]) => [Number(id), label]));
  if (newId && !postLabel.has(Number(newId))) postLabel.set(Number(newId), 'new');
  const userLabel = new Map(Object.entries(users).map(([label, id]) => [Number(id), label]));
  const pl = id => (id === null ? null : postLabel.get(Number(id)) ?? 'other-post');
  const ul = id => (id === null ? null : userLabel.get(Number(id)) ?? 'other-user');
  const mask = value => (typeof value === 'string' ? value.split(token).join('<token>') : value);
  const sortRows = rows => rows.map(row => JSON.stringify(row)).sort();

  // A question's hotness is checked against the formula for its current answers and votes
  // (the timestamps differ between backends, so the raw values cannot be compared).
  const hotnessOk = async postid => {
    const [[row]] = await pool.execute(
      "SELECT p.hotness, ((TO_DAYS(p.created)-734138)*86400.0+TIME_TO_SEC(p.created))*100 + ((TO_DAYS(COALESCE(MAX(c.created),p.created))-734138)*86400.0+TIME_TO_SEC(COALESCE(MAX(c.created),p.created)))*100 " +
      "+ COUNT(c.postid)*100*160000 + p.netvotes*100*160000 + p.views*100*4000 AS expected FROM qa_posts p LEFT JOIN qa_posts c ON c.parentid=p.postid AND c.type='A' WHERE p.postid=? GROUP BY p.postid", [postid]);
    return Math.abs(Number(row.hotness) - Number(row.expected)) <= Math.abs(Number(row.expected)) * 1e-6;
  };

  // Close notes belong to their question.
  const [notes] = await pool.query("SELECT postid, parentid FROM qa_posts WHERE type='NOTE' AND parentid IN (?)", [[...postLabel.keys()]]);
  for (const note of notes) if (postLabel.has(Number(note.parentid))) postLabel.set(Number(note.postid), `note:${postLabel.get(Number(note.parentid))}`);
  const posts = {};
  const postIds = [...postLabel.keys()];
  const [postRows] = await pool.query(
    'SELECT postid, type, parentid, userid, CAST(cookieid AS CHAR) AS cookieid, INET6_NTOA(createip) AS createip, title, content, format, tags, notify, name, categoryid, catidpath1, ' +
    'acount, amaxvote, upvotes, downvotes, netvotes, flagcount, selchildid, closedbyid, created IS NOT NULL AS hascreated, ' +
    'updated IS NOT NULL AS hasupdated, updatetype, lastuserid, INET6_NTOA(lastip) AS lastip FROM qa_posts WHERE postid IN (?)', [postIds]);
  const cookieids = [];
  for (const row of postRows) {
    const label = postLabel.get(Number(row.postid));
    if (row.cookieid) cookieids.push(row.cookieid);
    posts[label] = {
      ...row, postid: undefined, cookieid: row.cookieid !== null, parentid: pl(row.parentid), userid: ul(row.userid), lastuserid: ul(row.lastuserid),
      selchildid: pl(row.selchildid), closedbyid: pl(row.closedbyid),
      title: mask(row.title), content: mask(row.content), tags: mask(row.tags),
      hotnessOk: row.type === 'Q' ? await hotnessOk(row.postid) : undefined,
    };
  }

  const [metas] = focusId ? await pool.query('SELECT title, content FROM qa_postmetas WHERE postid=?', [focusId]) : [[]];
  const index = {};
  if (focusId) {
    const words = async (table, extra = '') => {
      const [rows] = await pool.query(`SELECT w.word${extra} FROM ${table} t JOIN qa_words w USING (wordid) WHERE t.postid=?`, [focusId]);
      return sortRows(rows.map(row => ({ ...row, word: mask(row.word), questionid: row.questionid === undefined ? undefined : pl(row.questionid) })));
    };
    index.title = await words('qa_titlewords');
    index.content = await words('qa_contentwords', ', t.count, t.type, t.questionid');
    index.tagwords = await words('qa_tagwords');
    index.posttags = await words('qa_posttags');
  }

  const [wordRows] = await pool.query('SELECT word, titlecount, contentcount, tagwordcount, tagcount FROM qa_words');
  const words = new Map(wordRows.map(row => [mask(row.word), [row.titlecount, row.contentcount, row.tagwordcount, row.tagcount].map(Number)]));

  const caches = {};
  for (const name of CACHES) {
    const [[row]] = await pool.execute('SELECT content FROM qa_options WHERE title=?', [name]);
    caches[name] = row ? Number(row.content) : 0;
  }
  const [[tagcount]] = await pool.query("SELECT (SELECT content FROM qa_options WHERE title='cache_tagcount') AS cached, (SELECT COUNT(*) FROM qa_words WHERE tagcount>0) AS actual");

  const points = {};
  for (const [label, userid] of Object.entries(users)) {
    const [[row]] = await pool.execute('SELECT * FROM qa_userpoints WHERE userid=?', [userid]);
    if (row) delete row.userid;
    points[label] = row ?? null;
  }
  const limits = {};
  for (const action of ['Q', 'A', 'C', 'F', 'M', 'W']) {
    limits[action] = [
      await limitRows(pool, 'SELECT userid AS k, period, count FROM qa_userlimits WHERE userid=? AND action=?', [users.actor, action]),
      await limitRows(pool, 'SELECT HEX(ip) AS k, period, count FROM qa_iplimits WHERE action=?', [action]),
    ];
  }
  const [[actor = null]] = await pool.execute('SELECT written IS NOT NULL AS written, INET6_NTOA(writeip) AS writeip FROM qa_users WHERE userid=?', [users.actor]);
  const writers = {};
  for (const [label, userid] of Object.entries(users)) {
    const [[row]] = await pool.execute('SELECT written IS NOT NULL AS written FROM qa_users WHERE userid=?', [userid]);
    writers[label] = row?.written ?? null; // null once the user is deleted
  }
  // Favorites of the test users, with how many update events each copied into their stream.
  const userIds = Object.values(users);
  const favoriteEntity = async (type, id) => {
    if (type === 'Q') return pl(id);
    if (type === 'U') return ul(id);
    if (type === 'T') {
      const [[word]] = await pool.execute('SELECT word FROM qa_words WHERE wordid=?', [id]);
      return mask(word?.word);
    }
    return String(id);
  };
  const [favoriteRows] = await pool.query(
    'SELECT f.userid, f.entitytype, f.entityid, f.nouserevents, (SELECT COUNT(*) FROM qa_userevents e WHERE e.userid=f.userid AND e.entitytype=f.entitytype AND e.entityid=f.entityid) AS events ' +
    'FROM qa_userfavorites f WHERE f.userid IN (?)', [userIds]);
  const favorites = sortRows(await Promise.all(favoriteRows.map(async row => ({
    userid: ul(row.userid), entitytype: row.entitytype, entityid: await favoriteEntity(row.entitytype, row.entityid), nouserevents: row.nouserevents, events: Number(row.events),
  }))));
  const [entityEventRows] = await pool.query("SELECT userid, entitytype, COUNT(*) AS n FROM qa_userevents WHERE userid IN (?) AND entitytype<>'-' GROUP BY userid, entitytype", [userIds]);
  const entityEvents = sortRows(entityEventRows.map(row => ({ userid: ul(row.userid), entitytype: row.entitytype, n: Number(row.n) })));
  const [[copyOption]] = await pool.query("SELECT content FROM qa_options WHERE title='max_copy_user_updates'");
  // Private messages and wall posts between the test users, and each user's cached wall post count.
  const [messageRows] = await pool.query(
    'SELECT type, fromuserid, touserid, fromhidden, tohidden, content, format FROM qa_messages WHERE fromuserid IN (?) OR touserid IN (?)', [userIds, userIds]);
  const messages = sortRows(messageRows.map(row => ({ ...row, fromuserid: ul(row.fromuserid), touserid: ul(row.touserid), content: mask(row.content) })));
  const wallposts = {};
  for (const [label, userid] of Object.entries(users)) {
    const [[row]] = await pool.execute('SELECT wallposts FROM qa_users WHERE userid=?', [userid]);
    wallposts[label] = row?.wallposts ?? null;
  }
  // Votes and flags on the tracked posts.
  const [voteRows] = await pool.query('SELECT postid, userid, vote, flag FROM qa_uservotes WHERE postid IN (?)', [postIds]);
  const uservotes = sortRows(voteRows.map(row => ({ postid: pl(row.postid), userid: ul(row.userid), vote: row.vote, flag: row.flag })));

  // Update streams for every question involved.
  const questionIds = postRows.filter(row => row.type.startsWith('Q')).map(row => Number(row.postid));
  const eventEntity = async row => {
    if (row.entitytype === 'Q') return pl(row.entityid);
    if (row.entitytype === 'U') return ul(row.entityid);
    if (row.entitytype === 'T') {
      const [[word]] = await pool.execute('SELECT word FROM qa_words WHERE wordid=?', [row.entityid]);
      return mask(word?.word);
    }
    return row.entityid;
  };
  const [shared] = await pool.query('SELECT entitytype, entityid, questionid, lastpostid, updatetype, lastuserid FROM qa_sharedevents WHERE questionid IN (?)', [questionIds]);
  const [personal] = await pool.query('SELECT userid, entitytype, entityid, questionid, lastpostid, updatetype, lastuserid FROM qa_userevents WHERE questionid IN (?)', [questionIds]);
  const normalizeEvent = async row => ({ ...row, entityid: await eventEntity(row), questionid: pl(row.questionid), lastpostid: pl(row.lastpostid), lastuserid: ul(row.lastuserid), userid: row.userid === undefined ? undefined : ul(row.userid) });
  const events = { shared: sortRows(await Promise.all(shared.map(normalizeEvent))), personal: sortRows(await Promise.all(personal.map(normalizeEvent))) };

  const [cookies] = cookieids.length
    ? await pool.query('SELECT INET6_NTOA(createip) AS createip, written IS NOT NULL AS written, INET6_NTOA(writeip) AS writeip FROM qa_cookies WHERE cookieid IN (?)', [cookieids])
    : [[]];

  return { posts, metas, index, words, caches, tagcountConsistent: Number(tagcount.cached) === Number(tagcount.actual), points, limits, actor, writers, uservotes, favorites, entityEvents, messages, wallposts, maxCopyUserUpdates: copyOption?.content ?? null, events, cookies: sortRows(cookies) };
}

// Values that depend on each database's earlier history are compared as changes.
function comparable(before, after) {
  const wordDelta = {};
  for (const [word, counts] of after.words) {
    const old = before.words.get(word) ?? [0, 0, 0, 0];
    const delta = counts.map((value, i) => value - old[i]);
    if (delta.some(Boolean)) wordDelta[word] = delta;
  }
  return {
    ...after,
    words: wordDelta,
    caches: Object.fromEntries(CACHES.map(key => [key, after.caches[key] - before.caches[key]])),
    limits: Object.fromEntries(Object.keys(after.limits).map(key => [key, after.limits[key].map((rows, i) => limitDelta(before.limits[key][i], rows))])),
  };
}


// The newest email Mailpit caught for an address (Q2A sends it before the page or API responds).
const MAILPIT_URL = process.env.MAILPIT_URL || 'http://localhost:8025';
async function latestEmail(address, { after = 0 } = {}) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const search = await request(MAILPIT_URL).get('/api/v1/search').query({ query: `to:"${address}"` });
    const newest = (search.body.messages ?? []).filter(m => new Date(m.Created).getTime() > after).sort((a, b) => new Date(b.Created) - new Date(a.Created))[0];
    if (newest) {
      const message = await request(MAILPIT_URL).get(`/api/v1/message/${newest.ID}`);
      return { subject: message.body.Subject, from: message.body.From, to: message.body.To, text: message.body.Text };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return null;
}
// Every email Mailpit catches while perform() runs (both sites and the API send before responding).
async function emailsDuring(perform) {
  const ids = async () => new Set(((await request(MAILPIT_URL).get('/api/v1/messages').query({ limit: 500 })).body.messages ?? []).map(m => m.ID));
  const before = await ids();
  const outcome = await perform();
  await new Promise(resolve => setTimeout(resolve, 150));
  const fresh = [...await ids()].filter(id => !before.has(id));
  const emails = [];
  for (const id of fresh) {
    const message = (await request(MAILPIT_URL).get(`/api/v1/message/${id}`)).body;
    emails.push({ from: message.From, replyTo: message.ReplyTo, to: message.To, subject: message.Subject, text: message.Text });
  }
  return { outcome, emails };
}
async function emailCount(address) {
  const search = await request(MAILPIT_URL).get('/api/v1/search').query({ query: `to:"${address}"` });
  return search.body.messages_count ?? (search.body.messages ?? []).length;
}

module.exports = { emailsDuring, limitRows, limitDelta, latestEmail, emailCount, PHP_URL, UI_URL, API_URL, siteDriver, apiDriver, createFixtures, snapshot, comparable, CACHES };
