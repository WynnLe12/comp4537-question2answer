// The rest of site administration (services/site-admin.js): categories, custom pages and links, widgets,
// user titles, user fields, mailings, plugins and the default avatar. Each scenario's outcome and complete
// write log (every repository call, in order, with its arguments, and every email sent) is a Jest
// snapshot. The admin parity suites compare these same writes with the PHP admin pages', so the snapshots
// record behaviour that matches PHP; update them (npx jest -u) only for a change those suites accept.
const sharp = require('sharp');
const nodemailer = require('nodemailer');
const text = require('../../src/q2a/text');
const { createSiteAdminService } = require('../../src/services/site-admin');
const { fakeRepository, optionsWith } = require('./fake-repository');

const sent = [];
beforeAll(() => {
  jest.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: async m => { sent.push(m); } }));
  jest.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000); // mailings pace themselves by the clock
  jest.spyOn(text, 'randomAlphanum').mockReturnValue('newcode1');
});
afterAll(() => jest.restoreAllMocks());

const OPTIONS = {
  smtp_active: '1', smtp_address: 'admin.test', smtp_port: '25', site_url: 'http://site.test/', neat_urls: '1', avatar_store_size: '30',
  mailing_from_email: 'm@site.test', mailing_from_name: 'Site', mailing_subject: 'News', mailing_body: '  Hello all  ', mailing_per_minute: '60',
  points_to_titles: '100 Pro,10 Regular,junk,abc Bad, 50  Middle ',
};
const CATEGORIES = [
  { categoryid: '1', parentid: null, title: 'Tech', tags: 'tech' },
  { categoryid: '2', parentid: '1', title: 'Phones', tags: 'phones' },
  { categoryid: '3', parentid: '2', title: 'Android', tags: 'android' },
  { categoryid: '4', parentid: null, title: 'Life', tags: 'life' },
  { categoryid: '5', parentid: '3', title: 'Pixel', tags: 'pixel' },
];
const FIELDS = [{ fieldid: '1', title: 'about', content: 'About' }, { fieldid: '2', title: 'location', content: 'Location' }, { fieldid: '3', title: 'web-site', content: 'Web site' }];
const PAGES = { 7: { pageid: '7', title: 'About us', flags: '0', tags: 'about-us', heading: 'About', content: 'x' }, 8: { pageid: '8', title: 'Blog', flags: '1', tags: 'http://blog.test' } };

async function run(method, request, { options = {}, answers = {}, level = 100 } = {}) {
  let nextId = 50;
  const fake = fakeRepository({
    findActor: id => (id === 1 ? { userid: 1, level } : null), loadOptions: optionsWith({ ...OPTIONS, ...options }),
    categories: CATEGORIES, categorySlugToId: (parentid, slug) => CATEGORIES.find(c => String(c.parentid ?? '') === String(parentid ?? '') && c.tags === slug)?.categoryid ?? null,
    pageWithSlug: slug => Object.values(PAGES).find(p => p.tags === slug) ?? null, page: id => PAGES[id] ?? null, categoryWithBackpath: path => (path === 'tech' ? { categoryid: 1 } : null),
    categoryCreate: () => nextId++, pageCreate: () => nextId++, widgetCreate: () => nextId++, userFieldCreate: () => nextId++,
    widget: id => (Number(id) === 9 ? { widgetid: '9', title: 'Related', tags: 'all' } : null), userFields: FIELDS,
    findAccount: { userid: 1, handle: 'admin', email: 'admin@x.test', emailcode: '' }, countUsers: 3,
    usersMailingNext: [{ userid: '2', handle: 'ann', email: 'ann@x.test', flags: '0', level: '0', emailcode: 'anncode' }, { userid: '3', handle: 'bob', email: 'bob@x.test', flags: '32', level: '0' }, { userid: '4', handle: 'cid', email: 'cid@x.test', flags: '0', level: '0', emailcode: '' }],
    blobCreate: 'blob99', ...answers,
  });
  const service = createSiteAdminService(fake.repository, { identify: async token => (token === 'ok' ? { id: 1 } : null) });
  sent.length = 0;
  let outcome;
  try { outcome = await service[method]({ token: 'ok', ip: '1.2.3.4', params: {}, ...request }); } catch (error) { outcome = { error: error.code, status: error.status, fields: error.fields }; }
  const writes = fake.calls.map(([name, ...args]) => [name, ...args.map(a => (a && typeof a.get === 'function' ? '<options>' : Buffer.isBuffer(a) ? '<image>' : a))]);
  return { outcome, writes, emails: sent.map(m => ({ to: m.to.address, subject: m.subject, text: m.text })) };
}

let png;
let notImage;
beforeAll(async () => {
  png = await sharp({ create: { width: 60, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.2 } } }).png().toBuffer();
  notImage = Buffer.from('not an image');
});

const SCENARIOS = {
  // categories
  'new top-level category, slug from the name': ['saveCategory', { body: { name: ' Sports & Games ', content: 'All about sports', position: 2 } }],
  'new subcategory with a given slug': ['saveCategory', { body: { name: 'Tablets', parentid: 1, slug: 'tabs' } }],
  'new category whose slug is taken: category-<slug>': ['saveCategory', { body: { name: 'Tech', parentid: 4 } }, { answers: { categorySlugToId: (p, s) => (s === 'tech' ? 1 : null) } }],
  'new category with a reserved slug': ['saveCategory', { body: { name: 'Questions' } }],
  'new category with a slug of a page': ['saveCategory', { body: { name: 'About us' } }],
  'refused: a sibling already has the name': ['saveCategory', { body: { name: 'tech' } }],
  'refused: no name': ['saveCategory', { body: { name: '0' } }],
  'refused: a name over 80 characters': ['saveCategory', { body: { name: 'n'.repeat(81) } }],
  'refused: a slug with a slash, when editing': ['saveCategory', { body: { categoryid: 4, name: 'Life', slug: 'a/b' } }],
  'refused: a slug over 200 characters, when editing': ['saveCategory', { body: { categoryid: 4, name: 'Life', slug: 's'.repeat(201) } }],
  'refused: an unknown parent': ['saveCategory', { body: { name: 'X', parentid: 99 } }],
  'refused: editing an unknown category': ['saveCategory', { body: { categoryid: 99, name: 'X' } }],
  'rename a category with subcategories (slug change asks for a recalc)': ['saveCategory', { body: { categoryid: 2, name: 'Mobiles', content: 'c', position: 1 } }],
  'rename a category keeping its slug': ['saveCategory', { body: { categoryid: 2, name: 'Phones', slug: 'phones' } }],
  'move a category under another': ['saveCategory', { body: { categoryid: 4, name: 'Life', setParent: true, parentid: 1 } }],
  'move a category to the top': ['saveCategory', { body: { categoryid: 2, name: 'Phones', setParent: true, parentid: null } }],
  'refused: moving a category under its own offspring': ['saveCategory', { body: { categoryid: 2, name: 'Phones', setParent: true, parentid: 3 } }],
  'refused: moving a category too deep': ['saveCategory', { body: { categoryid: 2, name: 'Phones', setParent: true, parentid: 7 } }, { answers: { categories: [...CATEGORIES, { categoryid: '6', parentid: '4', title: 'L2', tags: 'l2' }, { categoryid: '7', parentid: '6', title: 'L3', tags: 'l3' }] } }],
  'delete a category, moving its questions': ['deleteCategory', { params: { categoryid: '4' }, body: { reassignTo: 1 } }],
  'delete a category, leaving its questions without one': ['deleteCategory', { params: { categoryid: '4' } }],
  'refused: deleting a category with subcategories': ['deleteCategory', { params: { categoryid: '1' } }],
  'refused: moving questions into the same category': ['deleteCategory', { params: { categoryid: '4' }, body: { reassignTo: 4 } }],
  'refused: deleting an unknown category': ['deleteCategory', { params: { categoryid: '99' } }],
  'move a category\'s questions': ['reassignCategory', { params: { categoryid: '1' }, body: { reassignTo: 4 } }],
  'refused: moving questions to an unknown category': ['reassignCategory', { params: { categoryid: '1' }, body: { reassignTo: 99 } }],
  'refused: moving questions of an unknown category': ['reassignCategory', { params: { categoryid: '99' }, body: { reassignTo: 1 } }],
  // pages and links
  'new page': ['savePage', { body: { name: 'Contact', position: 'F3', permit: 150, heading: 'Contact us', content: '<p>Mail</p>' } }],
  'new page with a taken slug': ['savePage', { body: { name: 'About us' } }],
  'new page with a slug of a category': ['savePage', { body: { name: 'Tech' } }],
  'new page with a reserved slug': ['savePage', { body: { name: 'Users' } }],
  'new link in a new window': ['savePage', { body: { external: true, name: 'Docs', url: 'http://docs.test', newWindow: true, position: 'M1' } }],
  'refused: a link without a URL': ['savePage', { body: { external: true, name: 'Docs' } }],
  'refused: a page heading over 800 characters': ['savePage', { body: { name: 'Long', heading: 'h'.repeat(801) } }],
  'edit a page': ['savePage', { body: { pageid: 7, name: 'About', slug: 'about', heading: 'About', content: 'new', position: 'O2' } }],
  'edit a page keeping old values for fields that fail': ['savePage', { body: { pageid: 7, name: '', slug: 'a/b', heading: 'h'.repeat(801), content: 'kept' } }],
  'edit a link': ['savePage', { body: { pageid: 8, name: 'Blog', url: 'http://blog2.test', newWindow: false, permit: 120 } }],
  'edit a link keeping its URL when the new one fails': ['savePage', { body: { pageid: 8, name: 'Blog', url: 'u'.repeat(201) } }],
  'refused: editing an unknown page': ['savePage', { body: { pageid: 99, name: 'X' } }],
  'delete a page': ['deletePage', { params: { pageid: '7' } }],
  'refused: deleting an unknown page': ['deletePage', { params: { pageid: '99' } }],
  // widgets
  'add a widget': ['saveWidget', { body: { title: 'Related Questions', templates: ['question', 'qa'], position: 'SL2' } }],
  'move a widget': ['saveWidget', { body: { widgetid: 9, templates: ['all'], position: 'FH1' } }],
  'refused: a widget without a module': ['saveWidget', { body: { templates: ['all'] } }],
  'refused: a template name with odd characters': ['saveWidget', { body: { title: 'W', templates: ['a;b'] } }],
  'refused: templates that are not a list': ['saveWidget', { body: { title: 'W', templates: 'all' } }],
  'refused: an unknown widget': ['saveWidget', { body: { widgetid: 99, templates: ['all'] } }],
  'delete a widget': ['deleteWidget', { params: { widgetid: '9' } }],
  'refused: deleting an unknown widget': ['deleteWidget', { params: { widgetid: '99' } }],
  // user titles
  'add a user title': ['saveUserTitle', { body: { points: ' 500 ', title: ' Expert ' } }],
  'change a user title': ['saveUserTitle', { body: { oldPoints: 100, points: 200, title: 'Professional' } }],
  'change a title keeping its points when the new ones are taken': ['saveUserTitle', { body: { oldPoints: 100, points: 10, title: 'Pro+' } }],
  'change a title keeping its name when the new one is empty': ['saveUserTitle', { body: { oldPoints: 100, points: 150, title: '' } }],
  'remove a user title': ['saveUserTitle', { body: { oldPoints: 10, remove: true } }],
  'a title without points is reported, nothing changes': ['saveUserTitle', { body: { points: 'many', title: 'X' } }],
  'points already used are reported, nothing changes': ['saveUserTitle', { body: { points: 50, title: 'Half' } }],
  // user fields
  'add a user field': ['saveUserField', { body: { name: 'Favourite Food', type: 1, onRegister: true, permit: 120, position: 2 } }],
  'add a user field whose tag is taken': ['saveUserField', { body: { name: 'About' } }],
  'add a user field whose tag and next tag are taken': ['saveUserField', { body: { name: 'Web site' } }, { answers: { userFields: [...FIELDS, { fieldid: '4', title: 'web-site-2', content: 'x' }] } }],
  'edit a user field': ['saveUserField', { body: { fieldid: 2, name: 'Town', type: 2, permit: 150, position: 1 } }],
  'edit a user field keeping its name when the new one is too long': ['saveUserField', { body: { fieldid: 2, name: 'n'.repeat(41) } }],
  'refused: a new field name over 40 characters': ['saveUserField', { body: { name: 'n'.repeat(41) } }],
  'refused: editing an unknown field': ['saveUserField', { body: { fieldid: 99, name: 'X' } }],
  'delete a user field': ['deleteUserField', { params: { fieldid: '3' } }],
  'refused: deleting an unknown field': ['deleteUserField', { params: { fieldid: '99' } }],
  // mailings
  'send a test mailing to yourself (making an unsubscribe code)': ['mailingTest', {}],
  'start a mailing': ['mailingStart', {}],
  'starting while a mailing is under way changes nothing': ['mailingStart', {}, { options: { mailing_last_userid: '7' } }],
  'stop a mailing': ['mailingStop', {}],
  'a mailing step sends a batch, skipping users who opted out': ['mailingStep', {}, { options: { mailing_last_userid: '1', mailing_last_timestamp: '1799999990', mailing_done_users: '0' } }],
  'a mailing step skips unapproved users when users are moderated': ['mailingStep', {}, { options: { mailing_last_userid: '1', mailing_last_timestamp: '1799999990', mailing_done_users: '2', moderate_users: '1' } }],
  'a mailing step with no users left ends the mailing': ['mailingStep', {}, { options: { mailing_last_userid: '9', mailing_last_timestamp: '1799999990' }, answers: { usersMailingNext: [] } }],
  'a mailing step too soon sends nothing': ['mailingStep', {}, { options: { mailing_last_userid: '1', mailing_last_timestamp: '1800000000', mailing_per_minute: '1' } }],
  'a mailing step after a clock jump': ['mailingStep', {}, { options: { mailing_last_userid: '1', mailing_last_timestamp: '1800000500' } }],
  'a mailing step with no mailing running': ['mailingStep', {}],
  // plugins
  'enable plugins': ['setEnabledPlugins', { body: { directories: ['wysiwyg-editor', 'recaptcha-captcha'] } }],
  'refused: a plugin directory with a slash': ['setEnabledPlugins', { body: { directories: ['../x'] } }],
  'refused: plugin directories that are not a list': ['setEnabledPlugins', { body: { directories: 'x' } }],
  // the default avatar
  'upload a default avatar (resized, replacing the old one)': ['uploadDefaultAvatar', { image: 'png' }, { options: { avatar_default_blobid: 'old7' } }],
  'upload a small default avatar with no old one': ['uploadDefaultAvatar', { image: 'png' }, { options: { avatar_store_size: '100' } }],
  'a default avatar that could not be stored': ['uploadDefaultAvatar', { image: 'png' }, { answers: { blobCreate: null } }],
  'refused: a default avatar that is not an image': ['uploadDefaultAvatar', { image: 'bad' }],
  'refused: no default avatar image': ['uploadDefaultAvatar', { image: null }],
  // access
  'refused: below admin': ['saveWidget', { body: { title: 'W', templates: ['all'] } }, { level: 80 }],
};

describe.each(Object.entries(SCENARIOS))('%s', (name, [method, request, setup = {}]) => {
  test('writes', async () => {
    const req = { ...request, ...(request.image !== undefined ? { image: request.image === 'png' ? png : request.image === 'bad' ? notImage : null } : {}) };
    const result = await run(method, req, setup);
    expect(Boolean(result.outcome?.error)).toBe(name.startsWith('refused'));
    expect(result).toMatchSnapshot();
  });
});

test('signed out', async () => {
  const fake = fakeRepository({});
  const service = createSiteAdminService(fake.repository, { identify: async () => null });
  await expect(service.saveWidget({ token: 'x', body: {} })).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  await expect(service.getAiUsage({ token: 'x' })).rejects.toMatchObject({ status: 401 });
});
test('AI usage statistics are for admins only', async () => {
  const stats = { total: 3 };
  const make = actor => createSiteAdminService({}, { identify: async () => actor, aiRepository: { getUsageStatistics: async () => stats } });
  expect(await make({ id: 1, level: 100, flags: 0 }).getAiUsage({ token: 't' })).toBe(stats);
  await expect(make({ id: 1, level: 80, flags: 0 }).getAiUsage({ token: 't' })).rejects.toMatchObject({ status: 403, code: 'no_privileges' });
  await expect(make({ id: 1, level: 'x', flags: 0 }).getAiUsage({ token: 't' })).rejects.toMatchObject({ status: 403 });
  await expect(make({ id: 1, level: 120, flags: 2 }).getAiUsage({ token: 't' })).rejects.toMatchObject({ status: 403 });
});
