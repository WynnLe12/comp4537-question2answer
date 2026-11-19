// Site administration parity: the original PHP site, the shared Q2A UI backed by Node, and the Node API
// each change site settings through the real admin pages. Outcomes, page messages and everything
// written (options, categories, pages, widgets, user titles and fields, points, recounts) must match.
const { randomBytes } = require('node:crypto');
const { createPool } = require('../../src/db');
const { PHP_URL, UI_URL, siteDriver, apiDriver, emailsDuring } = require('./post-helpers');

describe('PHP ↔ Node site administration parity (original pages, shared UI bridge and API)', () => {
  const suffix = randomBytes(3).toString('hex');
  let phpPool, nodePool, backends;

  beforeAll(async () => {
    phpPool = createPool({ host: process.env.PHP_DB_HOST || 'php-db' });
    nodePool = createPool();
    backends = [];
    for (const [tag, pool, make] of [
      ['p', phpPool, () => siteDriver('php', PHP_URL, phpPool)],
      ['u', nodePool, () => siteDriver('migrated-ui', UI_URL, nodePool)],
      ['n', nodePool, () => apiDriver(nodePool)],
    ]) {
      const admin = make();
      const handle = `s${tag}${suffix}`;
      await admin.register(handle);
      await pool.execute('UPDATE qa_users SET level=100 WHERE handle=?', [handle]);
      backends.push({ admin, pool, tag, mark: `${tag}${suffix}`, make });
    }
  });
  afterAll(async () => { await Promise.all([phpPool.end(), nodePool.end()]); });

  const optionsOf = async pool => {
    const [rows] = await pool.query("SELECT title, content FROM qa_options WHERE title NOT LIKE 'cache\\_%'");
    return new Map(rows.map(row => [row.title, row.content]));
  };
  // An option's value as Q2A reads it: its row, or its default when it has none (the forms save
  // every option in their section, creating rows that only repeat the default).
  const defaults = require('../../src/data/option-defaults.json');
  const effective = (values, title) => {
    const value = values.has(title) ? values.get(title) : String(defaults[title] ?? '');
    return value === '' ? '0' : value; // checkbox and number options are saved as 0 where they were empty
  };
  // Each backend starts from the same option values (the shared UI and the API share a database),
  // and every option is put back afterwards.
  async function runOptions(section, baseline, perform) {
    const originals = new Map();
    for (const pool of [phpPool, nodePool]) originals.set(pool, await optionsOf(pool));
    const results = [];
    try {
      for (const b of backends) {
        // Viewing the page makes PHP store the defaults of the section's options; do that first on
        // each database (the API shares the shared UI's database).
        await (b.tag === 'n' ? backends[1] : b).admin.adminView?.(section);
        for (const [title, content] of Object.entries(baseline)) {
          await b.pool.execute('INSERT INTO qa_options (title, content) VALUES (?, ?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [title, content]);
        }
        const before = await optionsOf(b.pool);
        const outcome = await perform(b);
        const after = await optionsOf(b.pool);
        const changed = {};
        for (const title of after.keys()) if (effective(before, title) !== effective(after, title)) changed[title] = effective(after, title);
        results.push({ outcome, changed });
      }
    } finally {
      for (const [pool, values] of originals) {
        const now = await optionsOf(pool);
        for (const [title, content] of now) {
          if (!values.has(title)) await pool.execute('DELETE FROM qa_options WHERE title=?', [title]);
          else if (values.get(title) !== content) await pool.execute('UPDATE qa_options SET content=? WHERE title=?', [values.get(title), title]);
        }
      }
    }
    const [php, ui, api] = results;
    expect(ui.outcome.accepted).toBe(php.outcome.accepted);
    expect(api.outcome.accepted).toBe(php.outcome.accepted);
    expect(ui.outcome.message).toBe(php.outcome.message);
    expect(ui.changed).toEqual(php.changed);
    expect(api.changed).toEqual(php.changed);
    if (php.outcome.accepted) expect(ui.outcome.backend).toBe('node-api-v1');
    return { php, ui, api };
  }

  describe('options', () => {
    test('an admin saves the spam settings, which are kept within their limits', async () => {
      const { php } = await runOptions('spam', { flagging_hide_after: '5', max_rate_user_qs: '20', moderate_users: '1' },
        b => b.admin.adminOptions('spam', { flagging_hide_after: '1', max_rate_user_qs: '12abc', moderate_users: false }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.changed).toMatchObject({ flagging_hide_after: '2', max_rate_user_qs: '12', moderate_users: '0' });
    });
    test('an admin saves the posting settings, with blocked words tidied', async () => {
      const { php } = await runOptions('posting', { block_bad_words: '' },
        b => b.admin.adminOptions('posting', { block_bad_words: 'darn,  heck;gosh' }));
      expect(php.changed).toMatchObject({ block_bad_words: 'darn , heck , gosh' });
    });
    test('an admin saves the email settings', async () => {
      // email_privacy's default is a language string the form saves back, so it starts out stored.
      const privacy = require('../../src/data/admin-options.json').lang.default_privacy;
      const { php } = await runOptions('emails', { feedback_email: '', notify_admin_q_post: '0', email_privacy: privacy },
        b => b.admin.adminOptions('emails', { feedback_email: 'owner@example.test', notify_admin_q_post: true }));
      expect(php.changed).toMatchObject({ feedback_email: 'owner@example.test', notify_admin_q_post: '1' });
    });
    test('an admin saves the list sizes, capped at their maximum', async () => {
      const { php } = await runOptions('lists', { page_size_qs: '20', page_size_users: '30' },
        b => b.admin.adminOptions('lists', { page_size_qs: '5000', page_size_users: '0' }));
      expect(php.changed).toMatchObject({ page_size_qs: '50', page_size_users: '1' });
    });
    test('an admin blocks IP addresses for writing', async () => {
      const { php } = await runOptions('spam', { block_ips_write: '' },
        b => b.admin.adminOptions('spam', { block_ips_write: '10.0.0.1 - 10.0.0.9, 192.168.*.*' }));
      expect(php.changed).toMatchObject({ block_ips_write: '10.0.0.1-10.0.0.9 , 192.168.*.*' });
    });
    test('an admin resets the layout settings to their defaults', async () => {
      const names = ['logo_show', 'logo_url', 'logo_width', 'logo_height', 'show_custom_sidebar', 'custom_sidebar', 'show_custom_sidepanel', 'custom_sidepanel', 'show_custom_header', 'custom_header',
        'show_custom_footer', 'custom_footer', 'show_custom_in_head', 'custom_in_head', 'show_custom_home', 'custom_home_heading', 'custom_home_content', 'show_home_description', 'home_description'];
      const { php } = await runOptions('layout', { logo_show: '1', custom_sidebar: 'Old sidebar', show_custom_sidebar: '1', custom_header: 'Header', show_custom_header: '1' },
        b => b.admin.adminOptions('layout', {}, 'doresetoptions', names));
      expect(php.outcome.accepted).toBe(true);
      expect(php.changed.logo_show).toBe('0'); // empty, compared as 0
      expect(php.changed.custom_header).toBe('0');
    });
    test('only admins may change settings', async () => {
      const { api } = await runOptions('spam', {}, async b => {
        const visitor = b.make();
        await visitor.register(`v${b.mark}${randomBytes(2).toString('hex')}`);
        return visitor.adminOptions('spam', { flagging_hide_after: '3' });
      });
      expect(api.outcome).toMatchObject({ status: 403, code: 'no_privileges' });
    });
  });

  describe('categories', () => {
    const categoryRows = async b => {
      // The backpath holds every ancestor's slug, so subcategories of this backend's categories match too.
      const [rows] = await b.pool.query('SELECT categoryid, parentid, title, tags, content, position, backpath, qcount FROM qa_categories WHERE backpath LIKE ? OR title LIKE ?', [`%${b.mark}%`, `%${b.mark}%`]);
      return rows;
    };
    // This backend's categories, with IDs as names and top-level positions as their order among them
    // (the shared UI and the API add theirs to the same database).
    async function categoryState(b) {
      const rows = await categoryRows(b);
      const mask = value => (value === null ? null : String(value).split(b.mark).join('<b>'));
      const label = new Map(rows.map(row => [Number(row.categoryid), mask(row.tags)]));
      const top = rows.filter(row => row.parentid === null).sort((x, y) => x.position - y.position).map(row => Number(row.categoryid));
      return Object.fromEntries(rows.map(row => [mask(row.tags), {
        parent: row.parentid === null ? null : label.get(Number(row.parentid)) ?? 'other', title: mask(row.title), content: row.content, backpath: mask(row.backpath), qcount: row.qcount,
        position: row.parentid === null ? top.indexOf(Number(row.categoryid)) + 1 : row.position,
      }]));
    }
    const idOf = async (b, slug) => {
      const [[row]] = await b.pool.execute('SELECT categoryid FROM qa_categories WHERE tags=? AND backpath LIKE ?', [slug.split('<b>').join(b.mark), `%${b.mark}%`]);
      return row?.categoryid ?? null;
    };
    async function runCategories(perform) {
      const results = [];
      for (const b of backends) {
        const outcome = await perform(b);
        if (typeof outcome.message === 'string') outcome.message = outcome.message.split(b.mark).join('<b>');
        results.push({ outcome, state: await categoryState(b) });
      }
      const [php, ui, api] = results;
      expect(ui.outcome.accepted).toBe(php.outcome.accepted);
      expect(api.outcome.accepted).toBe(php.outcome.accepted);
      expect(ui.outcome.message).toBe(php.outcome.message);
      expect(ui.state).toEqual(php.state);
      expect(api.state).toEqual(php.state);
      if (php.outcome.accepted) expect(ui.outcome.backend).toBe('node-api-v1');
      return { php, ui, api };
    }
    afterAll(async () => {
      // Remove this run's categories so the other suites keep a site without them.
      for (const b of backends) {
        const rows = await categoryRows(b);
        for (const row of rows.sort((x, y) => (y.parentid === null) - (x.parentid === null))) {
          await b.pool.execute('UPDATE qa_posts SET categoryid=NULL WHERE categoryid=?', [row.categoryid]);
          await b.pool.execute('DELETE FROM qa_categories WHERE categoryid=?', [row.categoryid]);
        }
      }
    });

    test('an admin adds a top-level category; its slug comes from its name', async () => {
      const { php } = await runCategories(b => b.admin.adminCategorySave({ name: `Gardening ${b.mark}`, content: 'Plants and soil.' }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state['gardening-<b>']).toMatchObject({ parent: null, title: 'Gardening <b>', backpath: 'gardening-<b>', content: 'Plants and soil.' });
    });
    test('and a subcategory under it', async () => {
      const { php } = await runCategories(async b => b.admin.adminCategorySave({ parentid: await idOf(b, 'gardening-<b>'), name: 'Roses', content: '' }));
      expect(php.state.roses).toMatchObject({ parent: 'gardening-<b>', backpath: 'roses/gardening-<b>', position: 1 });
    });
    test('a second subcategory with the same name is refused', async () => {
      const { php, api } = await runCategories(async b => b.admin.adminCategorySave({ parentid: await idOf(b, 'gardening-<b>'), name: 'ROSES', content: '' }));
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ status: 400, code: 'validation_failed', fields: { name: 'exists' } });
    });
    test('an admin renames a category and changes its slug and description', async () => {
      const { php } = await runCategories(async b => b.admin.adminCategorySave({ categoryid: await idOf(b, 'gardening-<b>'), name: `Garden ${b.mark}`, slug: `garden-${b.mark}`, content: 'Everything outdoors.' }));
      expect(php.state['garden-<b>']).toMatchObject({ title: 'Garden <b>', content: 'Everything outdoors.', backpath: 'garden-<b>' });
    });
    test('a top-level slug that a Q2A page uses is refused', async () => {
      const { api } = await runCategories(async b => b.admin.adminCategorySave({ categoryid: await idOf(b, 'garden-<b>'), name: `Garden ${b.mark}`, slug: 'ask', content: '' }));
      expect(api.outcome).toMatchObject({ status: 400, fields: { slug: 'reserved' } });
    });
    test('a category with subcategories cannot be deleted, an empty one can', async () => {
      const blocked = await runCategories(async b => b.admin.adminCategorySave({ categoryid: await idOf(b, 'garden-<b>'), deleteIt: true }));
      expect(blocked.php.state['garden-<b>']).toBeDefined();
      const { php } = await runCategories(async b => b.admin.adminCategorySave({ categoryid: await idOf(b, 'roses'), deleteIt: true }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state.roses).toBeUndefined();
    });
  });

  describe('pages, widgets, user titles and user fields', () => {
    const HUGE = 100000; // the API's "last position": positions are kept within range
    async function runState(stateOf, perform, baseline = null) {
      const results = [];
      for (const b of backends) {
        if (baseline) await baseline(b);
        const outcome = await perform(b);
        if (typeof outcome.message === 'string') outcome.message = outcome.message.split(b.mark).join('<b>');
        results.push({ outcome, state: await stateOf(b) });
      }
      const [php, ui, api] = results;
      expect(ui.outcome.accepted).toBe(php.outcome.accepted);
      expect(api.outcome.accepted).toBe(php.outcome.accepted);
      expect(ui.outcome.message).toBe(php.outcome.message);
      expect(ui.state).toEqual(php.state);
      expect(api.state).toEqual(php.state);
      if (php.outcome.accepted) expect(ui.outcome.backend).toBe('node-api-v1');
      return { php, ui, api };
    }
    const mask = (b, value) => (value === null || value === undefined ? value : String(value).split(b.mark).join('<b>'));
    // Rows of a table that belong to this backend, in position order, with positions as their order.
    const ownRows = async (b, sql) => {
      const [rows] = await b.pool.query(sql, [`%${b.mark}%`]);
      return rows.sort((x, y) => x.position - y.position).map((row, index) => ({ ...row, position: index + 1 }));
    };
    const pagesOf = async b => (await ownRows(b, 'SELECT pageid, title, nav, flags, permit, tags, heading, content, position FROM qa_pages WHERE title LIKE ?'))
      .map(row => ({ title: mask(b, row.title), nav: row.nav, flags: row.flags, permit: row.permit, tags: mask(b, row.tags), heading: row.heading, content: row.content, position: row.position }));
    const pageId = async (b, title) => {
      const [[row]] = await b.pool.execute('SELECT pageid FROM qa_pages WHERE title=?', [title.split('<b>').join(b.mark)]);
      return row?.pageid;
    };
    afterAll(async () => {
      for (const b of backends) {
        await b.pool.query('DELETE FROM qa_pages WHERE title LIKE ?', [`%${b.mark}%`]);
        await b.pool.query('DELETE FROM qa_userfields WHERE content LIKE ?', [`%${b.mark}%`]);
      }
    });

    test('an admin adds a custom page; its slug comes from its name', async () => {
      const { php } = await runState(pagesOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'pages', { name: `About ${b.mark}`, heading: 'About us', content: '<p>Hello</p>', position: `F${HUGE}`, permit: 150 })
        : b.admin.adminForm({ path: 'admin/pages', reveal: 'doaddpage', submit: 'dosavepage', changes: { name: `About ${b.mark}`, heading: 'About us', content: '<p>Hello</p>', position: 'last', permit: '150' }, positionPrefix: 'F' })));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state[0]).toMatchObject({ title: 'About <b>', tags: 'about-<b>', heading: 'About us', nav: 'F' });
    });
    test('and an external link', async () => {
      const { php } = await runState(pagesOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'pages', { external: true, name: `Docs ${b.mark}`, url: 'https://example.test/docs', newWindow: true, position: `F${HUGE}`, permit: 150 })
        : b.admin.adminForm({ path: 'admin/pages', reveal: 'doaddlink', submit: 'dosavepage', changes: { name: `Docs ${b.mark}`, url: 'https://example.test/docs', newwindow: true, position: 'last', permit: '150' }, positionPrefix: 'F' })));
      expect(php.state[1]).toMatchObject({ title: 'Docs <b>', tags: 'https://example.test/docs', flags: 3 });
    });
    // A new page falls back to page-<slug> and page-1...; an edit keeps the old slug and reports it.
    test('changing a page to a slug that a Q2A page uses is refused', async () => {
      const { php, api } = await runState(pagesOf, async b => {
        const pageid = await pageId(b, 'About <b>');
        const [[page]] = await b.pool.execute('SELECT nav, position FROM qa_pages WHERE pageid=?', [pageid]); // stays where it is
        return b.tag === 'n'
          ? b.admin.adminApi('put', `pages/${pageid}`, { name: `About ${b.mark}`, slug: 'users', heading: 'About us too', content: '<p>Hello</p>', position: `${page.nav}${page.position}`, permit: 150 })
          : b.admin.adminForm({ path: `admin/pages&edit=${pageid}`, submit: 'dosavepage', changes: { slug: 'users', heading: 'About us too' } });
      });
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ errors: { slug: 'reserved' } });
      expect(php.state[0]).toMatchObject({ tags: 'about-<b>', heading: 'About us too' });
    });
    test('an admin deletes a page', async () => {
      const { php } = await runState(pagesOf, async b => {
        const pageid = await pageId(b, 'Docs <b>');
        return b.tag === 'n' ? b.admin.adminApi('delete', `pages/${pageid}`) : b.admin.adminForm({ path: `admin/pages&edit=${pageid}`, submit: 'dosavepage', changes: { dodelete: true } });
      });
      expect(php.state).toHaveLength(1);
    });

    // The widget this backend added most recently (the shared UI and the API share a database), and
    // how many of its kind remain.
    const widgetOf = async b => {
      const [rows] = await b.pool.query("SELECT widgetid, place, tags FROM qa_widgets WHERE title='Related Questions' ORDER BY widgetid DESC");
      const mine = rows.find(row => Number(row.widgetid) === b.widgetid);
      return mine ? { place: mine.place, tags: mine.tags } : null;
    };
    test('an admin adds a widget to every page', async () => {
      const { php } = await runState(widgetOf, async b => {
        const outcome = b.tag === 'n'
          ? await b.admin.adminApi('post', 'widgets', { title: 'Related Questions', templates: ['all'], position: `SL${HUGE}` })
          : await b.admin.adminForm({ path: 'admin/layoutwidgets&title=Related%20Questions', submit: 'dosavewidget', changes: { template_all: true, position: 'last' }, positionPrefix: 'SL' });
        const [[row]] = await b.pool.query("SELECT MAX(widgetid) AS id FROM qa_widgets WHERE title='Related Questions'");
        b.widgetid = Number(row.id);
        return outcome;
      });
      expect(php.outcome.accepted).toBe(true);
      expect(php.state).toEqual({ place: 'SL', tags: 'all' });
    });
    test('and removes it', async () => {
      const { php } = await runState(widgetOf, b => (b.tag === 'n'
        ? b.admin.adminApi('delete', `widgets/${b.widgetid}`)
        : b.admin.adminForm({ path: `admin/layoutwidgets&edit=${b.widgetid}`, submit: 'dosavewidget', changes: { dodelete: true } })));
      expect(php.state).toBeNull();
    });

    const titlesOf = async b => {
      const [[row]] = await b.pool.query("SELECT content FROM qa_options WHERE title='points_to_titles'");
      return row?.content ?? '';
    };
    const resetTitles = b => b.pool.execute("INSERT INTO qa_options (title, content) VALUES ('points_to_titles', '1000 Expert,100 Regular') ON DUPLICATE KEY UPDATE content=VALUES(content)");
    test('an admin adds a user title, kept in order of points', async () => {
      const { php } = await runState(titlesOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'user-titles', { title: 'Helper', points: '500' })
        : b.admin.adminForm({ path: 'admin/usertitles', submit: 'dosavetitle', changes: { title: 'Helper', points: '500' } })), resetTitles);
      expect(php.state).toBe('1000 Expert,500 Helper,100 Regular');
    });
    test('a title for points already used is refused', async () => {
      const { php, api } = await runState(titlesOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'user-titles', { title: 'Twice', points: '100' })
        : b.admin.adminForm({ path: 'admin/usertitles', submit: 'dosavetitle', changes: { title: 'Twice', points: '100' } })), resetTitles);
      expect(php.outcome.accepted).toBe(false);
      expect(api.outcome).toMatchObject({ errors: { points: 'exists' } }); // saved nothing new
    });
    test('an admin changes and removes user titles', async () => {
      const { php } = await runState(titlesOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'user-titles', { oldPoints: 100, title: 'Member', points: '50' })
        : b.admin.adminForm({ path: 'admin/usertitles&edit=100', submit: 'dosavetitle', changes: { title: 'Member', points: '50' } })), resetTitles);
      expect(php.state).toBe('1000 Expert,50 Member');
      const removed = await runState(titlesOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'user-titles', { oldPoints: 1000, remove: true })
        : b.admin.adminForm({ path: 'admin/usertitles&edit=1000', submit: 'dosavetitle', changes: { dodelete: true } })), resetTitles);
      expect(removed.php.state).toBe('100 Regular');
    });

    const fieldsOf = async b => (await ownRows(b, 'SELECT fieldid, title, content, flags, permit, position FROM qa_userfields WHERE content LIKE ?'))
      .map(row => ({ title: mask(b, row.title), content: mask(b, row.content), flags: row.flags, permit: row.permit, position: row.position }));
    const fieldId = async (b, content) => {
      const [[row]] = await b.pool.execute('SELECT fieldid FROM qa_userfields WHERE content=?', [content.split('<b>').join(b.mark)]);
      return row?.fieldid;
    };
    test('an admin adds a user field; its tag comes from its label', async () => {
      const { php } = await runState(fieldsOf, b => (b.tag === 'n'
        ? b.admin.adminApi('post', 'user-fields', { name: `Pronouns ${b.mark}`, type: 0, onRegister: true, position: HUGE, permit: 150 })
        : b.admin.adminForm({ path: 'admin/userfields', submit: 'dosavefield', changes: { name: `Pronouns ${b.mark}`, type: '0', onregister: true, position: 'last', permit: '150' } })));
      expect(php.outcome.accepted).toBe(true);
      expect(php.state[0]).toMatchObject({ title: 'pronouns-<b>', content: 'Pronouns <b>', flags: 4 });
    });
    test('an admin relabels it as a multi-line field', async () => {
      const { php } = await runState(fieldsOf, async b => {
        const fieldid = await fieldId(b, 'Pronouns <b>');
        return b.tag === 'n'
          ? b.admin.adminApi('put', `user-fields/${fieldid}`, { name: `About me ${b.mark}`, type: 1, onRegister: false, position: HUGE, permit: 150 })
          : b.admin.adminForm({ path: `admin/userfields&edit=${fieldid}`, submit: 'dosavefield', changes: { name: `About me ${b.mark}`, type: '1', onregister: false, position: 'last', permit: '150' } });
      });
      expect(php.state[0]).toMatchObject({ title: 'pronouns-<b>', content: 'About me <b>', flags: 1 });
    });
    test('an admin deletes it', async () => {
      const { php } = await runState(fieldsOf, async b => {
        const fieldid = await fieldId(b, 'About me <b>');
        return b.tag === 'n' ? b.admin.adminApi('delete', `user-fields/${fieldid}`) : b.admin.adminForm({ path: `admin/userfields&edit=${fieldid}`, submit: 'dosavefield', changes: { dodelete: true } });
      });
      expect(php.state).toHaveLength(0);
    });
  });

  describe('points, plugins and mailings', () => {
    test('an admin changes the points for asking a question', async () => {
      const { php } = await runOptions('points', { points_post_q: '2', points_post_a: '4' }, b => b.admin.adminPoints({ points_post_q: '5', points_post_a: '4' }));
      expect(php.outcome.accepted).toBe(true);
      expect(php.changed).toEqual({ points_post_q: '5' });
    });
    test('an admin enables and disables a plugin', async () => {
      const { php } = await runOptions('plugins', { enabled_plugins: '' }, b => b.admin.adminPlugins(['tag-cloud-widget']));
      expect(php.outcome.accepted).toBe(true);
      expect(php.changed).toEqual({ enabled_plugins: 'tag-cloud-widget' });
    });
    test('an admin sends themself a test mailing', async () => {
      const results = [];
      for (const b of backends) {
        await b.pool.query("INSERT INTO qa_options (title, content) VALUES ('mailing_enabled', '1'), ('mailing_subject', 'News'), ('mailing_body', 'Hello everyone'), ('mailing_from_name', 'Site'), ('mailing_from_email', 'news@example.test') ON DUPLICATE KEY UPDATE content=VALUES(content)");
        const { outcome, emails } = await emailsDuring(() => (b.tag === 'n' ? b.admin.adminApi('post', 'mailing/test') : b.admin.adminForm({ path: 'admin/mailing', submit: 'domailingtest' })));
        results.push({ outcome, emails: emails.map(e => ({ subject: e.subject, from: e.from, to: e.to.map(t => t.Address.split(b.mark).join('<b>')), text: e.text.split(b.mark).join('<b>').replace(/c=[0-9a-z]{8}/, 'c=<code>') })) });
      }
      const [php, ui, api] = results;
      expect(php.emails).toHaveLength(1);
      expect(ui.emails).toEqual(php.emails);
      expect(api.emails).toEqual(php.emails);
    });
  });
});
