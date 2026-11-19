// Site administration. Ports the admin pages that change the site (pages/admin/*): the option forms
// of admin-default.php (saving, resetting, the default avatar), and qa_reset_options() /
// qa_default_option() (app/options.php). Only admins may use them (qa_admin_check_privileges()).
const sharp = require('sharp');
const { ApiError } = require('../errors');
const { phpBool, phpInt, phpNum } = require('../q2a/php');
const { LEVEL, PERMIT } = require('../q2a/permissions');
const text = require('../q2a/text');
const optionData = require('../data/admin-options.json');
const fixedDefaults = require('../data/option-defaults.json');
const strings = require('../data/lang-strings.json');
const { sendEmail } = require('../q2a/mail');
const { pathAbsolute } = require('../q2a/paths');
const mailingLang = { unsubscribe: 'Unsubscribe:' }; // users/unsubscribe

const settable = new Set(optionData.settable);
// Besides the option forms' options: permissions, points and the pages admin's navigation options.
const isSettable = name => settable.has(name) || /^(permit|points|nav)_[a-z_]+$/.test(name);
const routing = new Set(require('../data/page-routing.json'));
const MAX_CAT_TITLE = 80; // QA_DB_MAX_CAT_PAGE_TITLE_LENGTH
const MAX_CAT_TAGS = 200; // QA_DB_MAX_CAT_PAGE_TAGS_LENGTH
const CATEGORY_DEPTH = 4; // QA_CATEGORY_DEPTH
const MAX_TITLE = 800; // QA_DB_MAX_TITLE_LENGTH
const MAX_PROFILE_TITLE = 40; // QA_DB_MAX_PROFILE_TITLE_LENGTH
const HOT_WEIGHTS = ['hot_weight_views', 'hot_weight_answers', 'hot_weight_votes', 'hot_weight_q_age', 'hot_weight_a_age'];

function createSiteAdminService(repository, { identify }) {
  async function transaction(request, work) {
    const identity = await identify(request.token);
    if (!identity) throw new ApiError(401, 'unauthenticated');
    return repository.transaction(async q => {
      const actor = await q.findActor(identity.id);
      if (!actor) throw new ApiError(401, 'unauthenticated');
      if (Number(actor.level) < LEVEL.ADMIN) throw new ApiError(403, 'no_privileges');
      return work({ q, actor, options: await q.loadOptions(), ip: request.ip });
    });
  }

  // admin-default.php's save loop: the posted text, made a number for number and checkbox options
  // (and non-empty number-blank ones), kept within the option's limits, with the few options the
  // page tidies up.
  function normalize(name, raw, options) {
    let value = raw === undefined || raw === null ? null : text.postText(String(raw));
    const type = optionData.type[name];
    if (type === 'number' || type === 'checkbox' || (type === 'number-blank' && String(value ?? '').length)) value = phpInt(value ?? 0);
    if (optionData.maximum[name] !== undefined) value = Math.min(optionData.maximum[name], phpNum(value ?? 0));
    if (optionData.minimum[name] !== undefined) value = Math.max(optionData.minimum[name], phpNum(value ?? 0));
    switch (name) {
      case 'site_url': if (!String(value ?? '').endsWith('/')) value = `${value ?? ''}/`; break;
      case 'block_ips_write': value = text.blockIpsExplode(value).join(' , '); break;
      case 'block_bad_words': case 'block_bad_usernames': value = text.blockWordsExplode(value).join(' , '); break;
      default:
    }
    return value ?? '';
  }

  // Save options: { values: { name: posted value } }. Returns whether hotness needs recalculating.
  async function saveOptions(request) {
    return transaction(request, async ({ q, options }) => {
      const values = request.body?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new ApiError(400, 'invalid_input', { values: 'invalid' });
      const unknown = Object.keys(values).filter(name => !isSettable(name));
      if (unknown.length) throw new ApiError(400, 'validation_failed', Object.fromEntries(unknown.map(name => [name, 'unknown_option'])));
      let recalcHotness = false;
      const saved = {};
      for (const [name, raw] of Object.entries(values)) {
        if (raw !== null && raw !== undefined && !['string', 'number', 'boolean'].includes(typeof raw)) throw new ApiError(400, 'invalid_input', { [name]: 'invalid' });
        const value = normalize(name, typeof raw === 'boolean' ? (raw ? '1' : '') : raw, options);
        if (HOT_WEIGHTS.includes(name) && String(options.get(name)) !== String(value)) recalcHotness = true;
        await q.setOption(name, value);
        saved[name] = String(value);
      }
      return { saved, recalcHotness };
    });
  }

  // qa_default_option() for the options an admin can reset. The site address and email come from the
  // request's host, as PHP takes them from $_SERVER.
  function defaultOption(name, options, site) {
    if (Object.hasOwn(fixedDefaults, name)) return fixedDefaults[name];
    const o = n => String(options.get(n) ?? '');
    switch (name) {
      case 'site_url': return `${site.https ? 'https' : 'http'}://${site.host}${site.directory}/`;
      case 'site_title': return defaultSiteTitle(site.host);
      case 'site_theme_mobile': return o('site_theme');
      case 'from_email': {
        const parts = String(site.host ?? '').split('.');
        if (parts.length > 2 && parts[0].length < 5 && !/^\d+$/.test(parts[0])) parts.shift();
        return `no-reply@${parts.length > 1 ? parts.join('.') : 'example.com'}`;
      }
      case 'email_privacy': return optionData.lang.default_privacy;
      case 'show_custom_sidebar': return o('custom_sidebar').length > 0 ? 1 : '';
      case 'show_custom_header': return o('custom_header').length > 0 ? 1 : '';
      case 'show_custom_footer': return o('custom_footer').length > 0 ? 1 : '';
      case 'show_custom_in_head': return o('custom_in_head').length > 0 ? 1 : '';
      case 'register_terms': return optionData.lang.default_terms.split('^').join(escapeHtml(o('site_title')));
      case 'block_bad_usernames': return strings['main/anonymous'];
      case 'custom_sidebar': return optionData.lang.default_sidebar.split('^').join(escapeHtml(o('site_title')));
      case 'editor_for_qs': case 'editor_for_as': return site.htmlEditor ?? '-';
      case 'permit_post_q': return phpBool(o('ask_needs_login')) ? PERMIT.USERS : PERMIT.ALL;
      case 'permit_post_a': return phpBool(o('answer_needs_login')) ? PERMIT.USERS : PERMIT.ALL;
      case 'permit_post_c': return phpBool(o('comment_needs_login')) ? PERMIT.USERS : PERMIT.ALL;
      case 'permit_retag_cat': return o('permit_edit_q');
      case 'points_vote_up_q': case 'points_vote_down_q': return numericOr(o('points_vote_on_q'), 1);
      case 'points_vote_up_a': case 'points_vote_down_a': return numericOr(o('points_vote_on_a'), 1);
      case 'points_per_q_voted_up': case 'points_per_q_voted_down': return numericOr(o('points_per_q_voted'), 1);
      case 'points_per_a_voted_up': case 'points_per_a_voted_down': return numericOr(o('points_per_a_voted'), 2);
      case 'captcha_module': return site.captchaModule ?? '';
      case 'mailing_from_name': return o('site_title');
      case 'mailing_from_email': return o('from_email');
      case 'mailing_subject': return optionData.lang.default_subject.split('^').join(o('site_title'));
      case 'mailing_body': return `\n\n\n--\n${o('site_title')}\n${o('site_url')}`;
      default: return '';
    }
  }

  // qa_reset_options(): { names, site: { host, https, directory, htmlEditor, captchaModule } }
  async function resetOptions(request) {
    return transaction(request, async ({ q, options }) => {
      const names = request.body?.names;
      if (!Array.isArray(names) || !names.every(name => typeof name === 'string')) throw new ApiError(400, 'invalid_input', { names: 'invalid' });
      const unknown = names.filter(name => !isSettable(name));
      if (unknown.length) throw new ApiError(400, 'validation_failed', Object.fromEntries(unknown.map(name => [name, 'unknown_option'])));
      const site = { host: request.host, https: false, directory: '', ...(request.body?.site ?? {}) };
      const saved = {};
      // qa_set_option() updates PHP's option cache, so a later default sees the earlier ones.
      const current = { get: name => (Object.hasOwn(saved, name) ? saved[name] : options.get(name)) };
      for (const name of names) {
        const value = defaultOption(name, current, site);
        await q.setOption(name, value);
        saved[name] = String(value);
      }
      return { saved };
    });
  }

  // admin-default.php's default avatar upload: resized like user avatars and stored as a blob.
  async function uploadDefaultAvatar(request) {
    return transaction(request, async ({ q, options }) => {
      const image = request.image;
      if (!Buffer.isBuffer(image) || !image.length) throw new ApiError(400, 'validation_failed', { image: 'required' });
      const size = phpNum(options.get('avatar_store_size'));
      let data;
      let width;
      let height;
      try {
        ({ width, height } = await sharp(image).metadata());
        if (width > size || height > size) {
          const multiplier = Math.min(size / width, size / height);
          width = Math.floor(width * multiplier);
          height = Math.floor(height * multiplier);
        }
        data = await sharp(image).flatten({ background: '#ffffff' }).resize(width, height, { fit: 'fill' }).jpeg({ quality: 90 }).toBuffer();
      } catch {
        throw new ApiError(400, 'image_not_read');
      }
      const oldblobid = String(options.get('avatar_default_blobid') ?? '');
      const blobid = await q.blobCreate(data, 'jpeg');
      if (blobid) {
        await q.setOption('avatar_default_blobid', blobid);
        await q.setOption('avatar_default_width', width);
        await q.setOption('avatar_default_height', height);
        await q.setOption('avatar_default_show', 1);
      }
      if (oldblobid.length) await q.blobDelete(oldblobid);
      return { blobid, width, height };
    });
  }

  // --- categories (pages/admin/admin-categories.php) ---

  // qa_admin_is_slug_reserved(): Q2A's own pages and a few fixed names (plugin pages are not known here).
  function slugReserved(slug, requestMap = []) {
    const part = String(slug).trim().toLowerCase();
    if (routing.has(part) || routing.has(`${part}/`) || /^\d+(\.\d+)?$/.test(part)) return true;
    if (requestMap.some(mapped => String(mapped).trim().toLowerCase() === part)) return true;
    return ['', 'qa', 'feed', 'install', 'url', 'image', 'ajax'].includes(part);
  }
  const lower = value => String(value).toLowerCase();
  const sameId = (a, b) => String(a ?? '') === String(b ?? '');

  // Save a category: { categoryid (to edit), parentid, name, slug, content, position, setParent }.
  // Returns its ID and whether categories need recalculating, as the page's redirect does.
  async function saveCategory(request) {
    return transaction(request, async ({ q }) => {
      const body = request.body ?? {};
      const all = await q.categories();
      const byId = new Map(all.map(c => [Number(c.categoryid), c]));
      const editing = body.categoryid !== undefined && body.categoryid !== null ? byId.get(Number(body.categoryid)) : null;
      if (body.categoryid !== undefined && body.categoryid !== null && !editing) throw new ApiError(404, 'category_not_found');
      const setParent = Boolean(editing && body.setParent);
      const parentid = setParent || !editing ? (body.parentid === undefined || body.parentid === null ? null : Number(body.parentid)) : editing.parentid;
      if (parentid !== null && !byId.has(Number(parentid))) throw new ApiError(400, 'validation_failed', { parentid: 'invalid' });
      if (setParent) checkNewParent(byId, editing, parentid);
      const hassub = editing ? all.some(c => sameId(c.parentid, editing.categoryid)) : false;
      const name = text.postText(body.name ?? '') ?? '';
      const content = body.content === undefined || body.content === null ? null : text.postText(String(body.content));
      const errors = {};
      // The name: required, within the length limit, and not used by a sibling (ignoring case)
      if (name === '' || name === '0') errors.name = 'required';
      else if (text.strlen(name) > MAX_CAT_TITLE) errors.name = 'max_length';
      else if (all.some(c => sameId(c.parentid, parentid) && !sameId(c.categoryid, editing?.categoryid) && lower(c.title) === lower(name))) errors.name = 'exists';
      // The slug: as given (or made from the name), then "category-<slug>", then "category-1", "category-2"... for a new category
      let slug;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (attempt === 0) slug = body.slug === undefined || body.slug === null ? text.stringToWords(name).join('-') : text.postText(String(body.slug));
        else if (attempt === 1) slug = optionData.lang.category_default_slug.split('^').join(slug);
        else slug = optionData.lang.category_default_slug.split('^').join(String(attempt - 1));
        const match = await q.categorySlugToId(parentid, slug);
        const page = parentid === null ? await q.pageWithSlug(slug) : null;
        delete errors.slug;
        if (slug === '' || slug === '0') errors.slug = 'required';
        else if (text.strlen(slug) > MAX_CAT_TAGS) errors.slug = 'max_length';
        else if (/[+/]/.test(slug)) errors.slug = 'invalid';
        else if (parentid === null && slugReserved(slug)) errors.slug = 'reserved';
        else if (match !== null && !sameId(match, editing?.categoryid)) errors.slug = 'exists';
        else if (page) errors.slug = 'page_exists';
        if (editing || !errors.slug) break;
      }
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);
      if (editing) {
        await q.categoryRename(editing.categoryid, name, slug);
        let recalc;
        if (setParent) {
          await q.categorySetParent(editing.categoryid, parentid);
          recalc = true;
        } else {
          await q.categorySetContent(editing.categoryid, content);
          if (body.position !== undefined && body.position !== null) await q.categorySetPosition(editing.categoryid, body.position);
          recalc = hassub && slug !== editing.tags;
        }
        return { categoryid: Number(editing.categoryid), recalc };
      }
      const categoryid = await q.categoryCreate(parentid, name, slug);
      await q.categorySetContent(categoryid, content);
      if (body.position !== undefined && body.position !== null) await q.categorySetPosition(categoryid, body.position);
      return { categoryid, recalc: false };
    });
  }

  // A category may move under another only if that is not itself or one of its offspring, and the
  // result stays within QA_CATEGORY_DEPTH levels (the page only offers such parents).
  function checkNewParent(byId, category, parentid) {
    if (parentid === null) return;
    let parentLevel = 0; // a top-level category is level 1
    for (let id = Number(parentid); id !== null && id !== undefined; id = byId.get(id)?.parentid ?? null) {
      if (id === Number(category.categoryid)) throw new ApiError(400, 'validation_failed', { parentid: 'invalid' });
      parentLevel++;
    }
    const subtreeDepth = id => Math.max(0, ...[...byId.values()].filter(c => sameId(c.parentid, id)).map(c => 1 + subtreeDepth(c.categoryid)));
    if (parentLevel + 1 + subtreeDepth(category.categoryid) > CATEGORY_DEPTH) throw new ApiError(400, 'validation_failed', { parentid: 'too_deep' });
  }

  // Delete a category with no subcategories, moving its questions to { reassignTo } (or none).
  async function deleteCategory(request) {
    return transaction(request, async ({ q }) => {
      const categoryid = Number(request.params.categoryid);
      const all = await q.categories();
      const category = all.find(c => Number(c.categoryid) === categoryid);
      if (!category) throw new ApiError(404, 'category_not_found');
      if (all.some(c => sameId(c.parentid, categoryid))) throw new ApiError(403, 'has_subcategories');
      const reassign = await reassignTarget(all, request.body?.reassignTo, categoryid);
      await q.categoryReassign(categoryid, reassign);
      await q.categoryDelete(categoryid);
      return { categoryid, deleted: true, recalc: true, parentid: category.parentid };
    });
  }

  // The page's "move questions" form: questions in a category (or with none) go to another.
  async function reassignCategory(request) {
    return transaction(request, async ({ q }) => {
      const categoryid = Number(request.params.categoryid);
      const all = await q.categories();
      if (!all.some(c => Number(c.categoryid) === categoryid)) throw new ApiError(404, 'category_not_found');
      const reassign = await reassignTarget(all, request.body?.reassignTo, categoryid);
      await q.categoryReassign(categoryid, reassign);
      return { categoryid, recalc: true };
    });
  }
  async function reassignTarget(all, value, categoryid) {
    if (value === undefined || value === null) return null;
    if (!all.some(c => Number(c.categoryid) === Number(value)) || Number(value) === categoryid) throw new ApiError(400, 'validation_failed', { reassignTo: 'invalid' });
    return Number(value);
  }

  // --- custom pages and links (pages/admin/admin-pages.php) ---
  const PAGE_FLAGS = { EXTERNAL: 1, NEW_WINDOW: 2 };
  // "O3": the navigation menu (one letter) and the position.
  const splitPosition = (value, placeLength) => [String(value ?? '').slice(0, placeLength), String(value ?? '').slice(placeLength)];

  // Save a page or link: { pageid (to edit), external, name, position, permit, url, newWindow,
  // heading, slug, content }. Editing keeps the old value of any field that fails its check, as the
  // page does; a new page is only created without errors.
  async function savePage(request) {
    return transaction(request, async ({ q }) => {
      const body = request.body ?? {};
      const editing = body.pageid !== undefined && body.pageid !== null ? await q.page(Number(body.pageid)) : null;
      if (body.pageid !== undefined && body.pageid !== null && !editing) throw new ApiError(404, 'page_not_found');
      const external = editing ? Boolean(Number(editing.flags) & PAGE_FLAGS.EXTERNAL) : Boolean(body.external);
      const str = name => (body[name] === undefined || body[name] === null ? null : text.postText(String(body[name])));
      const name = str('name') ?? '';
      const permit = phpInt(body.permit ?? 0);
      const url = str('url');
      const heading = str('heading');
      const content = str('content');
      const errors = {};
      if (name === '' || name === '0') errors.name = 'required';
      else if (text.strlen(name) > MAX_CAT_TITLE) errors.name = 'max_length';
      let slug = null;
      if (external) {
        if (!url || url === '0') errors.url = 'required';
        else if (text.strlen(url) > MAX_CAT_TAGS) errors.url = 'max_length';
      } else {
        if (text.strlen(heading ?? '') > MAX_TITLE) errors.heading = 'max_length';
        for (let attempt = 0; attempt < 100; attempt++) {
          if (attempt === 0) slug = body.slug === undefined || body.slug === null ? text.stringToWords(name).join('-') : text.postText(String(body.slug));
          else if (attempt === 1) slug = optionData.lang.page_default_slug.split('^').join(slug);
          else slug = optionData.lang.page_default_slug.split('^').join(String(attempt - 1));
          const matchcategory = await q.categoryWithBackpath(slug.split('/').reverse().join('/'));
          const matchpage = await q.pageWithSlug(slug);
          delete errors.slug;
          if (slug === '' || slug === '0') errors.slug = 'required';
          else if (text.strlen(slug) > MAX_CAT_TAGS) errors.slug = 'max_length';
          else if (/[+/]/.test(slug)) errors.slug = 'invalid';
          else if (slugReserved(slug)) errors.slug = 'reserved';
          else if (matchpage && !sameId(matchpage.pageid, editing?.pageid)) errors.slug = 'exists';
          else if (matchcategory) errors.slug = 'category_exists';
          if (editing || !errors.slug) break;
        }
      }
      const [nav, position] = splitPosition(body.position, 1);
      const flags = external ? PAGE_FLAGS.EXTERNAL | (body.newWindow ? PAGE_FLAGS.NEW_WINDOW : 0) : 0;
      if (editing) {
        const title = errors.name ? editing.title : name;
        if (external) await q.pageSetFields(editing.pageid, title, flags, errors.url ? editing.tags : url, null, null, permit);
        else await q.pageSetFields(editing.pageid, title, 0, errors.slug ? editing.tags : slug, errors.heading ? editing.heading : heading, content, permit);
        await q.pageMove(editing.pageid, nav, position);
        return { pageid: Number(editing.pageid), errors };
      }
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);
      const pageid = external ? await q.pageCreate(name, flags, url, null, null, permit) : await q.pageCreate(name, 0, slug, heading, content, permit);
      await q.pageMove(pageid, nav, position);
      return { pageid, slug, errors };
    });
  }
  async function deletePage(request) {
    return transaction(request, async ({ q }) => {
      const pageid = Number(request.params.pageid);
      if (!(await q.page(pageid))) throw new ApiError(404, 'page_not_found');
      await q.pageDelete(pageid); // the built-in search module does not index pages
      return { pageid, deleted: true };
    });
  }

  // --- widgets (pages/admin/admin-widgets.php) ---
  // { widgetid (to edit) or title (the widget module), templates: ['all' or template names],
  //   position: place (two letters) and position, e.g. "FH3" }
  async function saveWidget(request) {
    return transaction(request, async ({ q }) => {
      const body = request.body ?? {};
      const editing = body.widgetid !== undefined && body.widgetid !== null ? await q.widget(Number(body.widgetid)) : null;
      if (body.widgetid !== undefined && body.widgetid !== null && !editing) throw new ApiError(404, 'widget_not_found');
      if (!Array.isArray(body.templates) || !body.templates.every(t => typeof t === 'string' && /^[a-z_-]+$/i.test(t))) throw new ApiError(400, 'invalid_input', { templates: 'invalid' });
      const tags = body.templates.join(',');
      let widgetid;
      if (editing) {
        widgetid = editing.widgetid;
        await q.widgetSetFields(widgetid, tags);
      } else {
        const title = text.postText(String(body.title ?? ''));
        if (!title) throw new ApiError(400, 'validation_failed', { title: 'required' });
        widgetid = await q.widgetCreate(title, tags);
      }
      const [place, position] = splitPosition(body.position, 2);
      await q.widgetMove(widgetid, place, position);
      return { widgetid: Number(widgetid) };
    });
  }
  async function deleteWidget(request) {
    return transaction(request, async ({ q }) => {
      const widgetid = Number(request.params.widgetid);
      if (!(await q.widget(widgetid))) throw new ApiError(404, 'widget_not_found');
      await q.widgetDelete(widgetid);
      return { widgetid, deleted: true };
    });
  }

  // --- user titles (pages/admin/admin-usertitles.php) ---
  // The points_to_titles option, read like qa_get_points_to_titles().
  function pointsToTitles(value) {
    const titles = new Map();
    for (const pair of String(value ?? '').split(',')) {
      const space = pair.indexOf(' ');
      if (space < 0) continue;
      const points = pair.slice(0, space).trim();
      const title = pair.slice(space).trim();
      if (points !== '' && !Number.isNaN(Number(points)) && title.length) titles.set(phpInt(points), title);
    }
    return titles;
  }
  const titlesOption = titles => [...titles.entries()].sort((a, b) => b[0] - a[0]).map(([points, title]) => `${points} ${title}`).join(',');

  // Add, change or remove a title: { oldPoints (to change or remove), points, title, remove }. Like the
  // page, a field that fails its check keeps its old value when changing a title.
  async function saveUserTitle(request) {
    return transaction(request, async ({ q, options }) => {
      const body = request.body ?? {};
      const titles = pointsToTitles(options.get('points_to_titles'));
      const oldPoints = body.oldPoints === undefined || body.oldPoints === null ? null : phpInt(body.oldPoints);
      const errors = {};
      if (body.remove) titles.delete(oldPoints);
      else {
        const title = body.title === undefined || body.title === null ? '' : text.postText(String(body.title));
        const raw = body.points === undefined || body.points === null ? '' : String(body.points).trim();
        if (!title.length) errors.title = 'required';
        let points = null;
        if (raw === '' || Number.isNaN(Number(raw))) errors.points = 'required';
        else {
          points = phpInt(raw);
          if (titles.has(points) && (oldPoints === null || points !== oldPoints)) errors.points = 'exists';
        }
        if (oldPoints !== null && titles.has(oldPoints)) {
          const newPoints = errors.points ? oldPoints : points;
          const newTitle = errors.title ? titles.get(oldPoints) : title;
          titles.delete(oldPoints);
          titles.set(newPoints, newTitle);
        } else if (!Object.keys(errors).length) titles.set(points, title);
      }
      await q.setOption('points_to_titles', titlesOption(titles));
      return { titles: Object.fromEntries(titles), errors };
    });
  }

  // --- user fields (pages/admin/admin-userfields.php) ---
  const FIELD_FLAGS = { ON_REGISTER: 4 };
  // { fieldid (to edit), name, type (0, 1 multi-line, 2 link), onRegister, position, permit }
  async function saveUserField(request) {
    return transaction(request, async ({ q }) => {
      const body = request.body ?? {};
      const fields = await q.userFields();
      const editing = body.fieldid !== undefined && body.fieldid !== null ? fields.find(f => Number(f.fieldid) === Number(body.fieldid)) : null;
      if (body.fieldid !== undefined && body.fieldid !== null && !editing) throw new ApiError(404, 'field_not_found');
      const name = text.postText(String(body.name ?? '')) ?? '';
      const flags = phpInt(body.type ?? 0) | (body.onRegister ? FIELD_FLAGS.ON_REGISTER : 0);
      const permit = phpInt(body.permit ?? 0);
      const errors = {};
      if (text.strlen(name) > MAX_PROFILE_TITLE) errors.name = 'max_length';
      if (editing) {
        await q.userFieldSetFields(editing.fieldid, errors.name ? editing.content : name, flags, permit);
        await q.userFieldMove(editing.fieldid, body.position);
        return { fieldid: Number(editing.fieldid), errors };
      }
      if (Object.keys(errors).length) throw new ApiError(400, 'validation_failed', errors);
      // A unique tag made from the name: "name", then "name-2", "name-3"...
      for (let attempt = 0; attempt < 1000; attempt++) {
        const suffix = attempt ? `-${1 + attempt}` : '';
        const tag = [...text.stringToWords(name).join('-')].slice(0, MAX_PROFILE_TITLE - suffix.length).join('') + suffix;
        if (!fields.some(f => lower(tag.trim()) === lower(String(f.title).trim()))) {
          const fieldid = await q.userFieldCreate(tag, name, flags, permit);
          await q.userFieldMove(fieldid, body.position);
          return { fieldid, title: tag, errors };
        }
      }
      throw new ApiError(503, 'no_unique_tag');
    });
  }
  async function deleteUserField(request) {
    return transaction(request, async ({ q }) => {
      const fieldid = Number(request.params.fieldid);
      if (!(await q.userFields()).some(f => Number(f.fieldid) === fieldid)) throw new ApiError(404, 'field_not_found');
      await q.userFieldDelete(fieldid);
      return { fieldid, deleted: true };
    });
  }

  // --- mailings (app/mailing.php) ---
  // qa_mailing_send_one(): the mailing to one user, with an unsubscribe link (making them a code if needed).
  async function mailingEmail(q, options, user) {
    let code = String(user.emailcode ?? '');
    if (!code.trim().length) {
      code = text.randomAlphanum(8);
      await q.userSetEmailcode(user.userid, code);
    }
    const unsubscribe = pathAbsolute(options, 'unsubscribe', { c: code, u: user.handle });
    return {
      fromemail: options.get('mailing_from_email'), fromname: options.get('mailing_from_name'), toemail: user.email, toname: user.handle,
      subject: options.get('mailing_subject'), body: `${String(options.get('mailing_body') ?? '').trim()}\n\n\n${mailingLang.unsubscribe} ${unsubscribe}`,
    };
  }
  // The "send test" button: the mailing to the admin themself.
  async function mailingTest(request) {
    const email = await transaction(request, async ({ q, options, actor }) => ({ options, email: await mailingEmail(q, options, await q.findAccount(actor.userid)) }));
    return { sent: await sendEmail(email.options, email.email) };
  }
  // qa_mailing_start(): begin with the first user, unless a mailing is under way.
  async function mailingStart(request) {
    return transaction(request, async ({ q, options }) => {
      if (String(options.get('mailing_last_userid') ?? '').length === 0) {
        await q.setOption('mailing_last_timestamp', Math.floor(Date.now() / 1000));
        await q.setOption('mailing_last_userid', '0');
        await q.setOption('mailing_total_users', await q.countUsers());
        await q.setOption('mailing_done_users', 0);
      }
      return { started: true };
    });
  }
  // qa_mailing_stop()
  async function mailingStop(request) {
    return transaction(request, async ({ q }) => {
      for (const name of ['mailing_last_timestamp', 'mailing_last_userid', 'mailing_done_users', 'mailing_total_users']) await q.setOption(name, '');
      return { stopped: true };
    });
  }
  // qa_mailing_perform_step(): send the next batch, paced at mailing_per_minute.
  async function mailingStep(request) {
    const batch = await transaction(request, async ({ q, options }) => {
      const lastuserid = String(options.get('mailing_last_userid') ?? '');
      if (!lastuserid.length) return { active: false, emails: [] };
      const thistime = Math.floor(Date.now() / 1000);
      let lasttime = phpNum(options.get('mailing_last_timestamp'));
      const perminute = phpNum(options.get('mailing_per_minute'));
      if (lasttime - thistime > 60) lasttime = thistime - 1;
      else lasttime = Math.max(lasttime, thistime - 6);
      const count = Math.min(Math.floor((thistime - lasttime) * perminute / 60), 100);
      if (count === 0) return { active: true, emails: [] };
      await q.setOption('mailing_last_timestamp', thistime + 30);
      const users = await q.usersMailingNext(phpInt(lastuserid), count);
      if (!users.length) {
        for (const name of ['mailing_last_timestamp', 'mailing_last_userid', 'mailing_done_users', 'mailing_total_users']) await q.setOption(name, '');
        return { active: false, emails: [] };
      }
      await q.setOption('mailing_last_userid', Math.max(phpInt(lastuserid), ...users.map(u => Number(u.userid))));
      await q.setOption('mailing_done_users', phpInt(options.get('mailing_done_users')) + users.length);
      const moderating = phpBool(options.get('moderate_users'));
      const emails = [];
      for (const user of users) {
        const flags = Number(user.flags);
        if ((flags & 32) || (flags & 2) || (moderating && Number(user.level) < LEVEL.APPROVED)) continue; // no mailings, blocked, unapproved
        emails.push(await mailingEmail(q, options, user));
      }
      await q.setOption('mailing_last_timestamp', lasttime + emails.length * 60 / perminute);
      return { active: true, emails, options };
    });
    for (const email of batch.emails) await sendEmail(batch.options, email);
    return { active: batch.active, sent: batch.emails.length };
  }

  // --- plugins (pages/admin/admin-plugins.php) ---
  // The enabled plugins' directories (the PHP page knows which plugins are installed).
  async function setEnabledPlugins(request) {
    return transaction(request, async ({ q }) => {
      const directories = request.body?.directories;
      if (!Array.isArray(directories) || !directories.every(d => typeof d === 'string' && /^[^/\;]+$/.test(d))) throw new ApiError(400, 'invalid_input', { directories: 'invalid' });
      await q.setOption('enabled_plugins', directories.join(';'));
      return { directories };
    });
  }

  return {
    mailingTest, mailingStart, mailingStop, mailingStep, setEnabledPlugins,
    saveOptions, resetOptions, uploadDefaultAvatar, saveCategory, deleteCategory, reassignCategory,
    savePage, deletePage, saveWidget, deleteWidget, saveUserTitle, saveUserField, deleteUserField, normalize, defaultOption,
  };
}

const numericOr = (value, fallback) => (value !== '' && !Number.isNaN(Number(value)) ? value : fallback);
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// qa_default_site_title(): the longest part of the host name, capitalised, then "Q&A"
function defaultSiteTitle(host) {
  let longest = '';
  for (const part of String(host ?? '').split('.')) if (part.length > longest.length) longest = part;
  return (longest.length > 3 ? `${longest.charAt(0).toUpperCase()}${longest.slice(1)} ` : '') + optionData.lang.default_suffix;
}

module.exports = { createSiteAdminService };
