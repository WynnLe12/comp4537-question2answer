// Resetting admin options (qa_reset_options()) against Q2A's own qa_default_option(): php-helpers-outputs.json
// holds what PHP gives for every option an admin can reset, for several sites and option values
// (tests/fixtures/php-helpers.php, scripts/php-fixtures.sh). Node's resetOptions() must give the same.
const php = require('../fixtures/php-helpers-outputs.json');
const { createSiteAdminService } = require('../../src/services/site-admin');
const { fakeRepository, optionsWith } = require('./fake-repository');

test('every option resets to what PHP gives, for each site and set of options', async () => {
  const wrong = [];
  for (const [set, [host, script, https], defaults] of php.resetDefaults) {
    const fake = fakeRepository({ findActor: { userid: 1, level: 100 }, loadOptions: optionsWith(set) });
    const service = createSiteAdminService(fake.repository, { identify: async () => ({ id: 1 }) });
    // PHP: dirname($_SERVER['SCRIPT_NAME']) without its trailing slash; HTTPS on unless empty or "off".
    const site = { host, https: Boolean(https) && https !== 'off', directory: script.replace(/\/[^/]*$/, '') };
    for (const [name, expected] of Object.entries(defaults)) {
      const { saved } = await service.resetOptions({ token: 't', host, body: { names: [name], site } });
      if (saved[name] !== (expected ?? '')) wrong.push({ host, name, php: expected, node: saved[name] });
    }
  }
  expect(wrong).toEqual([]);
});

describe('saving options (admin-default.php)', () => {
  const { rejectsWith } = require('./fake-repository');
  const setup = (level = 100, current = { hot_weight_views: '100' }) => {
    const fake = fakeRepository({ findActor: id => (id === 1 ? { userid: 1, level } : null), loadOptions: optionsWith(current) });
    const service = createSiteAdminService(fake.repository, { identify: async token => (token === 't' ? { id: 1 } : token === 'ghost' ? { id: 2 } : null) });
    return { ...fake, save: (values, token = 't') => service.saveOptions({ token, body: { values } }) };
  };
  test.each([
    ['a number option is made an integer', 'avatar_profile_size', ' 12.7abc ', '12'],
    ['an empty number is 0', 'avatar_profile_size', '', '0'],
    ['a missing number is 0', 'avatar_profile_size', null, '0'],
    ['a checkbox true is 1', 'allow_close_questions', true, '1'],
    ['a checkbox false is 0', 'allow_close_questions', false, '0'],
    ['a checkbox "on" is 0, as (int)"on"', 'allow_close_questions', 'on', '0'],
    ['a number-blank option may stay empty', 'logo_width', '', ''],
    ['a number-blank option with a value is an integer', 'logo_width', '40.5', '40'],
    ['a value over the maximum is capped', 'feed_number_items', '999', '50'],
    ['a value under the minimum is raised', 'flagging_hide_after', '0', '2'],
    ['the site URL gets a trailing slash', 'site_url', ' http://x.test ', 'http://x.test/'],
    ['a site URL with its slash is kept', 'site_url', 'http://x.test/', 'http://x.test/'],
    ['an empty site URL becomes "/"', 'site_url', null, '/'],
    ['blocked IPs are tidied into a list', 'block_ips_write', '1.2.3.4\n5.6.7.8 - 5.6.7.9', '1.2.3.4 , 5.6.7.8-5.6.7.9'],
    ['blocked words are tidied into a list', 'block_bad_words', 'bad;worse  awful', 'bad , worse , awful'],
    ['blocked usernames too', 'block_bad_usernames', 'admin,root', 'admin , root'],
    ['text is trimmed with its line breaks normalised', 'custom_sidebar', '  a\r\nb  ', 'a\nb'],
    ['a missing text is empty', 'custom_sidebar', undefined, ''],
    ['a permission option is settable by its pattern', 'permit_foo_bar', '70', '70'],
    ['a navigation option too', 'nav_custom_page', '1', '1'],
  ])('%s', async (label, name, raw, expected) => {
    const s = setup();
    const { saved } = await s.save({ [name]: raw });
    expect(saved).toEqual({ [name]: expected });
    expect(s.named('setOption')).toEqual([['setOption', name, expect.anything()]]);
    expect(String(s.named('setOption')[0][2])).toBe(expected);
  });
  test('changing a hotness weight asks for a recalculation; saving the same value does not', async () => {
    expect((await setup().save({ hot_weight_views: '50' })).recalcHotness).toBe(true);
    expect((await setup().save({ hot_weight_views: '100', site_title: 'x' })).recalcHotness).toBe(false);
    expect((await setup().save({ hot_weight_answers: '100' })).recalcHotness).toBe(true);
    expect((await setup().save({ max_len_q_title: '5' })).recalcHotness).toBe(false);
  });
  test('unknown options are refused before anything is saved', async () => {
    const s = setup();
    await rejectsWith(s.save({ site_title: 'x', not_an_option: '1', 'permit-x': '1' }), 400, 'validation_failed', { not_an_option: 'unknown_option', 'permit-x': 'unknown_option' });
    expect(s.named('setOption')).toEqual([]);
  });
  test.each([[null], [[]], ['x'], [undefined]])('values %j are refused', async values => {
    await rejectsWith(setup().save(values), 400, 'invalid_input', { values: 'invalid' });
  });
  test('an object or array as a value is refused', async () => {
    await rejectsWith(setup().save({ site_title: { a: 1 } }), 400, 'invalid_input', { site_title: 'invalid' });
    await rejectsWith(setup().save({ site_title: ['a'] }), 400, 'invalid_input', { site_title: 'invalid' });
  });
  test('numbers are taken as text', async () => {
    expect((await setup().save({ site_title: 42 })).saved).toEqual({ site_title: '42' });
  });
  test('only admins: signed out, unknown account, or below admin', async () => {
    await rejectsWith(setup().save({ site_title: 'x' }, 'none'), 401, 'unauthenticated');
    await rejectsWith(setup().save({ site_title: 'x' }, 'ghost'), 401, 'unauthenticated');
    await rejectsWith(setup(99).save({ site_title: 'x' }), 403, 'no_privileges');
    await expect(setup(120).save({ site_title: 'x' })).resolves.toBeTruthy();
  });
  test('resetting needs a list of known option names', async () => {
    const fake = fakeRepository({ findActor: { userid: 1, level: 100 }, loadOptions: optionsWith({ site_title: 'T' }) });
    const service = createSiteAdminService(fake.repository, { identify: async () => ({ id: 1 }) });
    await rejectsWith(service.resetOptions({ token: 't', body: { names: 'site_title' } }), 400, 'invalid_input', { names: 'invalid' });
    await rejectsWith(service.resetOptions({ token: 't', body: { names: [5] } }), 400, 'invalid_input', { names: 'invalid' });
    await rejectsWith(service.resetOptions({ token: 't', body: { names: ['nope'] } }), 400, 'validation_failed', { nope: 'unknown_option' });
    // later defaults see earlier ones, as qa_set_option() updates PHP's cache; the site defaults to the request's host over http
    const { saved } = await service.resetOptions({ token: 't', host: 'www.example.test', body: { names: ['site_title', 'mailing_from_name', 'site_url', 'editor_for_qs', 'captcha_module'] } });
    expect(saved).toEqual({ site_title: 'Example Q&A', mailing_from_name: 'Example Q&A', site_url: 'http://www.example.test/', editor_for_qs: '-', captcha_module: '' });
    const withModules = await service.resetOptions({ token: 't', host: 'h.test', body: { names: ['editor_for_as', 'captcha_module'], site: { htmlEditor: 'WYSIWYG Editor', captchaModule: 'reCAPTCHA' } } });
    expect(withModules.saved).toEqual({ editor_for_as: 'WYSIWYG Editor', captcha_module: 'reCAPTCHA' });
  });
});
