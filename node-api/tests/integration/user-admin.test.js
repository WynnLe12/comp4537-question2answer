const request = require('supertest');
const { createApp } = require('../../src/app');
const { createUserAdminService } = require('../../src/services/user-admin');

const options = { get: name => ({ moderate_users: '1' }[name] ?? ''), dbTime: 0 };

describe('user administration rules (pages/user-profile.php)', () => {
  const { rulesFor } = createUserAdminService({}, { identify: async () => null });
  const user = (level, flags = 0, userid = 2) => ({ userid, level, flags, points: 0 });
  test('admins assign up to moderator, moderators up to expert, super admins anything', () => {
    expect(rulesFor(user(100, 0, 1), user(0), [], options).maxlevelassign).toBe(80);
    expect(rulesFor(user(80, 0, 1), user(0), [], options).maxlevelassign).toBe(20);
    expect(rulesFor(user(120, 0, 1), user(100), [], options).maxlevelassign).toBe(120);
  });
  test('nobody changes themselves or someone at their own level, including category levels', () => {
    expect(rulesFor(user(100, 0, 2), user(0, 0, 2), [], options).editable).toBe(false);
    expect(rulesFor(user(80, 0, 1), user(80), [], options).editable).toBe(false);
    expect(rulesFor(user(80, 0, 1), user(0), [{ level: 80 }], options).editable).toBe(false);
  });
  test('blocked users can be promoted only to editor, and only then removed', () => {
    const blocked = rulesFor(user(120, 0, 1), user(0, 2), [], options);
    expect(blocked.maxlevelassign).toBe(50);
    expect(blocked.removable).toBe(true);
    expect(rulesFor(user(120, 0, 1), user(0), [], options).removable).toBe(false);
  });
  test('only admins edit fields; moderators approve and block from the approve page', () => {
    const moderator = rulesFor(user(80, 0, 1), user(0), [], options);
    expect(moderator).toMatchObject({ fieldseditable: false, adminApprove: true, adminBlock: true });
    expect(rulesFor(user(50, 0, 1), user(0), [], options)).toMatchObject({ adminApprove: false, maxlevelassign: null });
  });
});

describe('user administration routes (service replaced)', () => {
  const calls = [];
  const userAdminService = new Proxy({}, { get: (target, name) => async req => { calls.push([name, req]); return { ok: true }; } });
  const app = createApp({ service: {}, userAdminService });
  test('route each operation by handle', async () => {
    calls.length = 0;
    const send = (method, url, body = {}) => request(app)[method](url).set('X-Q2A-Request', '1').send(body).expect(200);
    await send('patch', '/api/v1/users/bob', { email: 'b@example.test' });
    await send('put', '/api/v1/users/bob/level', { level: 20 });
    await send('post', '/api/v1/users/bob/approve');
    await send('put', '/api/v1/users/bob/block');
    await send('delete', '/api/v1/users/bob/block');
    await send('post', '/api/v1/users/bob/hide-posts');
    await send('delete', '/api/v1/users/bob');
    expect(calls.map(([name, req]) => `${name}:${req.handle}`)).toEqual(
      ['editUser:bob', 'changeLevel:bob', 'approveUser:bob', 'blockUser:bob', 'unblockUser:bob', 'hidePosts:bob', 'deleteUser:bob']);
  });
});
