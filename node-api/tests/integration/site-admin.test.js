const request = require('supertest');
const { createApp } = require('../../src/app');
const { createSiteAdminService } = require('../../src/services/site-admin');

describe('admin option rules (admin-default.php, qa_default_option())', () => {
  const { normalize, defaultOption } = createSiteAdminService({}, { identify: async () => null });
  const options = values => ({ get: name => values[name] ?? '' });
  test('numbers and checkboxes become integers, within their limits', () => {
    expect(normalize('max_rate_user_qs', '12abc')).toBe(12);
    expect(normalize('flagging_hide_after', '1')).toBe(2);
    expect(normalize('page_size_qs', '5000')).toBe(50);
    expect(normalize('captcha_on_feedback', null)).toBe(0);
  });
  test('the site address gets a trailing slash and block lists are tidied', () => {
    expect(normalize('site_url', 'http://example.test')).toBe('http://example.test/');
    expect(normalize('block_bad_words', 'darn,  heck;gosh')).toBe('darn , heck , gosh');
    expect(normalize('block_ips_write', '10.0.0.1 - 10.0.0.9, 192.168.*.*')).toBe('10.0.0.1-10.0.0.9 , 192.168.*.*');
  });
  test('defaults that depend on the host and on other options', () => {
    const site = { host: 'www.example.org', https: true, directory: '/qa' };
    expect(defaultOption('site_url', options({}), site)).toBe('https://www.example.org/qa/');
    expect(defaultOption('from_email', options({}), site)).toBe('no-reply@example.org');
    expect(defaultOption('site_title', options({}), site)).toBe('Example Q&A');
    expect(defaultOption('show_custom_sidebar', options({ custom_sidebar: 'x' }), site)).toBe(1);
    expect(defaultOption('mailing_body', options({ site_title: 'S', site_url: 'http://s/' }), site)).toBe('\n\n\n--\nS\nhttp://s/');
  });
});

describe('site administration routes (service replaced)', () => {
  const calls = [];
  const proxy = () => new Proxy({}, { get: (target, name) => async req => { calls.push([name, req]); return { state: '' }; } });
  const app = createApp({ service: {}, siteAdminService: proxy(), recalcService: proxy() });
  test('route each operation', async () => {
    calls.length = 0;
    const send = (method, url, body = {}) => request(app)[method](url).set('X-Q2A-Request', '1').send(body).expect(200);
    await send('put', '/api/v1/admin/options', { values: {} });
    await send('post', '/api/v1/admin/options/reset', { names: [] });
    await send('post', '/api/v1/admin/categories');
    await send('put', '/api/v1/admin/categories/4');
    await send('delete', '/api/v1/admin/categories/4');
    await send('post', '/api/v1/admin/pages');
    await send('delete', '/api/v1/admin/widgets/2');
    await send('post', '/api/v1/admin/user-titles');
    await send('put', '/api/v1/admin/user-fields/3');
    await send('post', '/api/v1/admin/recalc', { state: 'dorecountposts' });
    await send('post', '/api/v1/admin/mailing/step');
    await send('put', '/api/v1/admin/plugins', { directories: [] });
    expect(calls.map(([name]) => name)).toEqual(['saveOptions', 'resetOptions', 'saveCategory', 'saveCategory', 'deleteCategory', 'savePage', 'deleteWidget', 'saveUserTitle', 'saveUserField', 'perform', 'mailingStep', 'setEnabledPlugins']);
    expect(calls[3][1].body.categoryid).toBe(4);
  });
});
