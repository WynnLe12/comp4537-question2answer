// The message and user-administration services driven directly, with the repository replaced: every
// rule and every write. The parity suites hold the same services to the PHP site; these pin each rule.
const { createMessageService } = require('../../src/services/messages');
const { createUserAdminService } = require('../../src/services/user-admin');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const identify = async token => ({ ok: { id: 7 }, ghost: { id: 99 } }[token] ?? null);

describe('private messages (pages/message.php, qa_pm_send())', () => {
  const OPTIONS = { allow_private_messages: '1', show_message_history: '1', max_rate_user_messages: '10', max_rate_ip_messages: '10', site_url: 'http://site.test/', neat_urls: '1', site_title: 'Site' };
  const me = { userid: 7, handle: 'me', level: 0, flags: 0, points: 0 };
  const bob = { userid: 8, handle: 'bob', flags: 0 };
  function setup({ options = {}, user = me, to = bob, limits = {} } = {}) {
    const fake = fakeRepository({
      loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 7 ? user : null),
      findUserByHandle: handle => (handle === to?.handle ? to : undefined), findLimits: limits, messageCreate: 41,
      findUserEmailHandle: { email: 'bob@x.test', handle: 'bob' },
    });
    const service = createMessageService(fake.repository, { identify });
    return { ...fake, send: (body, handle = 'bob', token = 'ok') => service.sendMessage({ token, handle, body, ip: '1.2.3.4' }) };
  }
  test('saves the message, counts it, records the write; the email is reported (SMTP off here)', async () => {
    const s = setup();
    expect(await s.send({ content: '  Hello\r\nthere  ' })).toEqual({ id: 41, to: { userid: 8, handle: 'bob' }, emailed: false });
    expect(s.named('messageCreate', 'incrementLimits', 'userWritten')).toEqual([
      ['messageCreate', 7, 8, 'Hello\nthere', '', false], ['incrementLimits', 7, '1.2.3.4', 'M', 2000], ['userWritten', 7, '1.2.3.4'],
    ]);
    expect(s.named('findLimits')).toEqual([['findLimits', 7, '1.2.3.4', 'M']]);
  });
  test('without message history the message is emailed but not stored', async () => {
    const s = setup({ options: { show_message_history: '0' } });
    expect((await s.send({ content: 'hi' })).id).toBeNull();
    expect(s.names()).not.toContain('messageCreate');
    expect(s.names()).toContain('incrementLimits');
  });
  test.each([
    ['to yourself', { handle: 'me' }, 403, 'no_permission'],
    ['to nobody', { handle: '' }, 404, 'user_not_found'],
    ['to an unknown user', { handle: 'ghost' }, 404, 'user_not_found'],
    ['when private messages are off', { options: { allow_private_messages: '0' } }, 404, 'user_not_found'],
    ['to a user who refuses messages', { to: { ...bob, flags: 16 } }, 403, 'messages_disabled'],
    ['over the rate limit', { limits: { user: { period: 2000, count: 10 } } }, 429, 'message_limit'],
    ['when blocked', { user: { ...me, flags: 2 } }, 403, 'no_permission'],
  ])('refused %s', async (label, { handle = 'bob', ...setupArgs }, status, code) => {
    const s = setup(setupArgs);
    await rejectsWith(s.send({ content: 'hi' }, handle), status, code);
    expect(s.named('messageCreate', 'incrementLimits', 'userWritten')).toEqual([]);
  });
  test.each([
    [{ content: '' }, 'required'], [{ content: '   ' }, 'required'], [{ content: '0' }, 'required'], [{}, 'required'], [undefined, 'required'],
    [{ content: 'x'.repeat(12001) }, 'max_length'],
  ])('content %j is refused', async (body, reason) => {
    await rejectsWith(setup().send(body), 400, 'validation_failed', { content: reason });
  });
  test('12000 characters are allowed, emoji are dropped, and non-text content is refused', async () => {
    const s = setup();
    await s.send({ content: '😀'.repeat(5) + 'x'.repeat(12000) });
    expect(s.named('messageCreate')[0][3]).toHaveLength(12000);
    await rejectsWith(s.send({ content: 5 }), 400, 'invalid_input', { content: 'invalid' });
    await rejectsWith(s.send({ content: ['x'] }), 400, 'invalid_input', { content: 'invalid' });
  });
  test('signed out, or an account that no longer exists', async () => {
    await rejectsWith(setup().send({ content: 'hi' }, 'bob', 'none'), 401, 'unauthenticated');
    await rejectsWith(setup().send({ content: 'hi' }, 'bob', 'ghost'), 401, 'unauthenticated');
  });
  test('the recipient\'s address is looked up for the email', async () => {
    const s = setup();
    expect((await s.send({ content: 'Hi Bob' })).emailed).toBe(false); // SMTP is off in these options
    expect(s.named('findUserEmailHandle')).toEqual([['findUserEmailHandle', 8]]);
  });
});

describe('message emails', () => {
  // The email the service builds, with SMTP on and the transport recorded.
  test('the recipient gets the message, with a reply link unless the sender refuses messages', async () => {
    const nodemailer = require('nodemailer');
    const sent = [];
    const create = jest.spyOn(nodemailer, 'createTransport').mockImplementation(() => ({ sendMail: async message => { sent.push(message); } }));
    try {
      const make = flags => {
        const fake = fakeRepository({
          loadOptions: optionsWith({ allow_private_messages: '1', show_message_history: '1', max_rate_user_messages: '9', max_rate_ip_messages: '9', smtp_active: '1', smtp_address: `mail${flags}.test`, smtp_port: '25', site_url: 'http://site.test/', neat_urls: '1', site_title: 'Site', from_email: 'f@site.test' }),
          findActor: { userid: 7, handle: 'me', level: 0, flags, points: 0 }, findUserByHandle: { userid: 8, handle: 'bob', flags: 0 },
          findLimits: {}, messageCreate: 1, findUserEmailHandle: { email: 'bob@x.test', handle: 'bob' },
        });
        return createMessageService(fake.repository, { identify }).sendMessage({ token: 'ok', handle: 'bob', body: { content: 'Hi Bob' }, ip: 'ip' });
      };
      expect((await make(0)).emailed).toBe(true);
      expect((await make(16)).emailed).toBe(true);
      expect(sent.map(m => m.to.address)).toEqual(['bob@x.test', 'bob@x.test']);
      expect(sent[0].text).toContain('Hi Bob');
      expect(sent[0].text).toContain('http://site.test/message/me');
      expect(sent[1].text).not.toContain('http://site.test/message/me');
      expect(sent[1].text).toContain('http://site.test/user/me');
      expect(sent[0].text).toContain('http://site.test/account');
    } finally { create.mockRestore(); }
  });
});

describe('wall posts (qa_wall_error_html(), qa_wall_add_post())', () => {
  const OPTIONS = { allow_user_walls: '1', permit_post_wall: '120', max_rate_user_messages: '10', max_rate_ip_messages: '10', confirm_user_emails: '1', moderate_users: '1', page_size_wall: '3' };
  const me = { userid: 7, handle: 'me', level: 10, flags: 1, points: 0 };
  const owner = { userid: 8, handle: 'owner', flags: 0 };
  function setup({ options = {}, user = me, to = owner, limits = {}, message, recent = [] } = {}) {
    const fake = fakeRepository({
      loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 7 ? user : null),
      findUserByHandle: handle => (handle === to?.handle ? to : undefined), findLimits: limits, messageCreate: 51,
      findMessage: id => (message && id === message.messageid ? message : undefined), recentWallPosts: recent,
    });
    const service = createMessageService(fake.repository, { identify });
    return {
      ...fake,
      post: (body, handle = 'owner') => service.postOnWall({ token: 'ok', handle, body, ip: '1.2.3.4' }),
      remove: messageid => service.deleteWallPost({ token: 'ok', messageid, ip: '1.2.3.4' }),
      hide: (box, messageid) => service.deleteMessage({ token: 'ok', box, messageid, ip: '1.2.3.4' }),
    };
  }
  test('a post: saved as public, the owner\'s count recounted, counted against the limit', async () => {
    const s = setup();
    expect(await s.post({ content: ' Hi! ' })).toEqual({ id: 51 });
    expect(s.named('messageCreate', 'userRecountPosts', 'incrementLimits')).toEqual([
      ['messageCreate', 7, 8, 'Hi!', '', true], ['userRecountPosts', 8], ['incrementLimits', 7, '1.2.3.4', 'W', 2000],
    ]);
    expect(s.named('findLimits')).toEqual([['findLimits', 7, '1.2.3.4', 'W']]);
    expect(s.afterCommit).toHaveLength(0); // the owner's email needs their address, which this fake has not got
  });
  test('"0" is a valid wall post (only the empty string is refused)', async () => {
    await setup().post({ content: '0' });
    await rejectsWith(setup().post({ content: '  ' }), 400, 'validation_failed', { content: 'required' });
  });
  test.each([
    ['to an unknown user', { handle: 'ghost' }, 404, 'user_not_found'],
    ['with no handle', { handle: '' }, 404, 'user_not_found'],
    ['when walls are off', { options: { allow_user_walls: '' } }, 403, 'no_permission'],
    ['on a wall that refuses posts', { to: { ...owner, flags: 256 } }, 403, 'wall_blocked'],
    ['over the limit', { limits: { ip: { period: 2000, count: 10 } } }, 429, 'wall_limit'],
    ['before confirming the email', { user: { ...me, level: 0, flags: 0 }, options: { permit_post_wall: '110' } }, 403, 'wall_must_confirm'],
    ['before being approved', { user: { ...me, level: 0 }, options: { permit_post_wall: '103' } }, 403, 'wall_must_be_approved'],
    ['below the required level', { options: { permit_post_wall: '100' } }, 403, 'no_permission'],
  ])('refused %s', async (label, { handle = 'owner', ...args }, status, code) => {
    const s = setup(args);
    await rejectsWith(s.post({ content: 'x' }, handle), status, code);
    expect(s.names()).not.toContain('messageCreate');
  });
  test('you may post on your own wall even when it refuses posts', async () => {
    await setup({ to: { ...me, flags: 256 } }).post({ content: 'x' }, 'me');
  });

  describe('deleting a wall post', () => {
    const post = (fromuserid, touserid, messageid = 60) => ({ messageid, type: 'PUBLIC', fromuserid, touserid });
    test('the wall owner may delete any post on it', async () => {
      const s = setup({ message: post(3, 7) });
      expect(await s.remove(60)).toEqual({ id: 60, deleted: true });
      expect(s.named('messageDelete', 'userRecountPosts')).toEqual([['messageDelete', 60], ['userRecountPosts', 7]]);
    });
    test('moderators who may hide and delete posts may delete on any wall', async () => {
      const s = setup({ message: post(3, 4), user: { ...me, level: 80 }, options: { permit_hide_show: '40', permit_delete_hidden: '40' } });
      await s.remove(60);
      expect(s.names()).toContain('messageDelete');
      await rejectsWith(setup({ message: post(3, 4), user: { ...me, level: 80 }, options: { permit_hide_show: '40', permit_delete_hidden: '20' } }).remove(60), 403, 'delete_not_allowed');
    });
    test('the author may delete their posts at the top of the wall, until someone else posted', async () => {
      const recent = [post(7, 4, 63), post(7, 4, 62), post(3, 4, 61), post(7, 4, 60)];
      const ok = setup({ message: post(7, 4, 62), recent, options: { permit_hide_show: '0', permit_delete_hidden: '0' } });
      await ok.remove(62);
      expect(ok.named('recentWallPosts')).toEqual([['recentWallPosts', 4, 3]]);
      await rejectsWith(setup({ message: post(7, 4, 60), recent, options: { permit_hide_show: '0', permit_delete_hidden: '0' } }).remove(60), 403, 'delete_not_allowed');
      await rejectsWith(setup({ message: post(7, 4, 99), recent: [post(7, 4, 63)], options: { permit_hide_show: '0', permit_delete_hidden: '0' } }).remove(99), 403, 'delete_not_allowed');
    });
    test('no ID, an unknown message or a private message is not found', async () => {
      await rejectsWith(setup().remove(null), 404, 'message_not_found');
      await rejectsWith(setup({ message: post(7, 7) }).remove(61), 404, 'message_not_found');
      await rejectsWith(setup({ message: { ...post(7, 7), type: 'PRIVATE' } }).remove(60), 404, 'message_not_found');
    });
  });

  describe('hiding a private message from a box (qa_pm_delete())', () => {
    const pm = changes => ({ messageid: 70, type: 'PRIVATE', fromuserid: 3, touserid: 7, fromhidden: 0, tohidden: 0, ...changes });
    test('the recipient hides it from their inbox; it is removed once both have hidden it', async () => {
      const s = setup({ message: pm() });
      expect(await s.hide('inbox', 70)).toEqual({ id: 70, box: 'inbox', deleted: true });
      expect(s.named('messageUserHide', 'messageDelete')).toEqual([['messageUserHide', 70, 'inbox'], ['messageDelete', 70, false]]);
    });
    test('the sender hides it from their outbox', async () => {
      const s = setup({ message: pm({ fromuserid: 7, touserid: 3 }) });
      await s.hide('outbox', 70);
      expect(s.named('messageUserHide')).toEqual([['messageUserHide', 70, 'outbox']]);
    });
    test.each([
      ['another box name', 'trash', pm(), 404, 'not_found'],
      ['someone else\'s inbox', 'inbox', pm({ touserid: 3 }), 404, 'message_not_found'],
      ['the outbox of a message you received', 'outbox', pm(), 404, 'message_not_found'],
      ['an already hidden message', 'inbox', pm({ tohidden: 1 }), 404, 'message_not_found'],
      ['a sent message already hidden from the outbox', 'outbox', pm({ fromuserid: 7, fromhidden: '1' }), 404, 'message_not_found'],
      ['a wall post', 'inbox', pm({ type: 'PUBLIC' }), 404, 'message_not_found'],
    ])('refused: %s', async (label, box, message, status, code) => {
      const s = setup({ message });
      await rejectsWith(s.hide(box, 70), status, code);
      expect(s.names()).not.toContain('messageUserHide');
    });
    test('no message ID', async () => {
      await rejectsWith(setup().hide('inbox', null), 404, 'message_not_found');
    });
  });
});

describe('user administration (pages/user-profile.php)', () => {
  const OPTIONS = { tags_or_categories: 'tc', permit_hide_show: '70', moderate_users: '1' };
  const accounts = {
    admin: { userid: 7, handle: 'admin', level: 100, flags: 0, points: 0 },
    super: { userid: 7, handle: 'super', level: 120, flags: 0, points: 0 },
    mod: { userid: 7, handle: 'mod', level: 80, flags: 0, points: 0 },
    editor: { userid: 7, handle: 'editor', level: 50, flags: 0, points: 0 },
  };
  function setup({ actor = 'admin', target = {}, levels = [], options = {}, answers = {}, postChangeService } = {}) {
    const bob = { userid: 8, handle: 'bob', level: 0, flags: 0, email: 'bob@x.test', points: 5, avatarblobid: null, ...target };
    const fake = fakeRepository({
      loadOptions: optionsWith({ ...OPTIONS, ...options }), findActor: id => (id === 7 ? accounts[actor] : null),
      findAccountByHandle: handle => (handle === 'bob' ? bob : undefined), userLevels: levels,
      categoryExists: id => id < 100, findUseridsByEmail: [], userFields: [{ title: 'about' }, { title: 'location' }],
      ...answers,
    });
    const service = createUserAdminService(fake.repository, { identify, postChangeService });
    const req = (body, handle = 'bob', token = 'ok') => ({ token, handle, body, ip: '1.2.3.4' });
    return { ...fake, service, req, bob };
  }

  describe('levels', () => {
    test('an admin raises a user to moderator at most; the change is recorded', async () => {
      const s = setup();
      expect(await s.service.changeLevel(s.req({ level: 120 }))).toEqual({ handle: 'bob', level: 80 });
      expect(s.named('userSetLevel', 'uapprovecountUpdate', 'userSetFlag', 'userWritten')).toEqual([
        ['userSetLevel', 8, 80], ['uapprovecountUpdate'], ['userSetFlag', 8, 512, false], ['userWritten', 7, '1.2.3.4'],
      ]);
    });
    test('the approval count is recounted only when crossing "approved"', async () => {
      const s = setup({ target: { level: 20 } });
      await s.service.changeLevel(s.req({ level: 50 }));
      expect(s.names()).not.toContain('uapprovecountUpdate');
      const down = setup({ target: { level: 20 } });
      await down.service.changeLevel(down.req({ level: 0 }));
      expect(down.names()).toContain('uapprovecountUpdate');
      expect(down.names()).not.toContain('userSetFlag'); // the must-approve flag is cleared only when approved
    });
    test('the same level writes nothing', async () => {
      const s = setup({ target: { level: 20 } });
      expect(await s.service.changeLevel(s.req({ level: 20 }))).toEqual({ handle: 'bob', level: 20 });
      expect(s.named('userSetLevel', 'userWritten')).toEqual([]);
    });
    test('approving a user emails them once their level reaches "approved"', async () => {
      const s = setup({ answers: { findUserEmailHandle: { email: 'bob@x.test', handle: 'bob' } } });
      await s.service.approveUser(s.req());
      expect(s.named('userSetLevel')).toEqual([['userSetLevel', 8, 10]]);
      expect(s.afterCommit).toHaveLength(1);
    });
    test('a moderator may only approve from the approve page, up to "approved"', async () => {
      const s = setup({ actor: 'editor' });
      await rejectsWith(s.service.changeLevel(s.req({ level: 10 })), 403, 'level_not_allowed');
      const mod = setup({ actor: 'mod', target: { level: 80 } });
      await rejectsWith(mod.service.approveUser(mod.req()), 403, 'level_not_allowed');
      const modOk = setup({ actor: 'mod', target: { level: 10, userid: 8 }, levels: [{ level: 80 }] });
      expect(await modOk.service.approveUser(modOk.req())).toEqual({ handle: 'bob', level: 10 });
      const notApprove = setup({ actor: 'mod', target: { level: 10 }, levels: [{ level: 80 }] });
      await rejectsWith(notApprove.service.changeLevel(notApprove.req({ level: 20 })), 403, 'level_not_allowed');
    });
    test.each([[{ level: '20' }, { level: 'invalid' }], [{ level: 2.5 }, { level: 'invalid' }], [{}, { level: 'required' }], [undefined, { level: 'required' }]])(
      'body %j is refused', async (body, fields) => {
        const s = setup();
        await rejectsWith(s.service.changeLevel(s.req(body)), 400, 'invalid_input', fields);
      });
    test('category levels are capped like the level and need categories in use', async () => {
      const s = setup();
      expect(await s.service.changeLevel(s.req({ categoryLevels: [{ categoryid: 3, level: 120 }, { categoryid: 4, level: 20 }] }))).toEqual({ handle: 'bob', level: 0 });
      expect(s.named('userLevelsSet')).toEqual([['userLevelsSet', 8, [{ entitytype: 'C', entityid: 3, level: 80 }, { entitytype: 'C', entityid: 4, level: 20 }]]]);
      expect(s.names()).not.toContain('userSetLevel');
      await rejectsWith(setup({ options: { tags_or_categories: 't' } }).service.changeLevel(s.req({ categoryLevels: [] })), 403, 'level_not_allowed');
      await rejectsWith(setup({ actor: 'mod', target: { level: 80 } }).service.changeLevel(s.req({ categoryLevels: [] })), 403, 'level_not_allowed');
    });
    test.each([
      [{ categoryLevels: 'all' }], [{ categoryLevels: [{ categoryid: '3', level: 20 }] }], [{ categoryLevels: [{ categoryid: 3, level: null }] }],
      [{ categoryLevels: [null] }], [{ categoryLevels: [{ categoryid: 300, level: 20 }] }],
    ])('category levels %j are refused', async body => {
      const s = setup();
      await rejectsWith(s.service.changeLevel(s.req(body)), 400, 'invalid_input', { categoryLevels: 'invalid' });
      expect(s.names()).not.toContain('userLevelsSet');
    });
    test('an empty list clears the category levels; level and category levels together', async () => {
      const s = setup();
      await s.service.changeLevel(s.req({ level: 20, categoryLevels: [] }));
      expect(s.named('userSetLevel', 'userLevelsSet')).toEqual([['userSetLevel', 8, 20], ['userLevelsSet', 8, []]]);
    });
  });

  describe('blocking', () => {
    test('blocking a user sets the flag, recounts users awaiting approval and records the write', async () => {
      const s = setup();
      expect(await s.service.blockUser(s.req())).toEqual({ handle: 'bob', blocked: true });
      expect(s.named('userSetFlag', 'uapprovecountUpdate', 'userWritten')).toEqual([['userSetFlag', 8, 2, true], ['uapprovecountUpdate'], ['userWritten', 7, '1.2.3.4']]);
      const un = setup({ target: { flags: 2 } });
      expect(await un.service.unblockUser(un.req())).toEqual({ handle: 'bob', blocked: false });
      expect(un.named('userSetFlag')).toEqual([['userSetFlag', 8, 2, false]]);
    });
    test('moderators and above may block anyone below them from the approve page, but unblock only on the profile', async () => {
      const s = setup({ actor: 'mod', target: { level: 50 } });
      await s.service.blockUser(s.req());
      await expect(setup({ actor: 'mod', target: { level: 80 } }).service.blockUser(s.req())).resolves.toBeTruthy();
      await rejectsWith(setup({ actor: 'mod', target: { level: 80, flags: 2 } }).service.unblockUser(s.req()), 403, 'unblock_not_allowed');
      await rejectsWith(setup({ actor: 'editor' }).service.blockUser(s.req()), 403, 'block_not_allowed');
    });
  });

  describe('editing', () => {
    test('an admin changes the email, which then needs confirming again, and the profile fields', async () => {
      const s = setup();
      const result = await s.service.editUser(s.req({ email: ' new@x.test ', profile: { about: ' Hi ', location: null, unknown: 'x' } }));
      expect(result).toEqual({ handle: 'bob', errors: {} });
      expect(s.named('findUseridsByEmail', 'userSetEmail', 'userSetFlag', 'profileSet', 'userWritten')).toEqual([
        ['findUseridsByEmail', 'new@x.test'], ['userSetEmail', 8, 'new@x.test'], ['userSetFlag', 8, 1, false],
        ['profileSet', 8, 'about', 'Hi'], ['profileSet', 8, 'location', ''], ['userWritten', 7, '1.2.3.4'],
      ]);
    });
    test('the same email writes nothing; its own address is not "taken"', async () => {
      const s = setup({ answers: { findUseridsByEmail: [8] } });
      expect(await s.service.editUser(s.req({ email: 'bob@x.test' }))).toEqual({ handle: 'bob', errors: {} });
      expect(s.names()).not.toContain('userSetEmail');
    });
    test.each([
      ['', 'required'], ['not-an-email', 'invalid'], [`a@${'d'.repeat(60)}.${'e'.repeat(13)}.test`, 'max_length'], ['taken@x.test', 'exists'],
    ])('email %j: %s, while valid profile fields are still saved', async (email, reason) => {
      const s = setup({ answers: { findUseridsByEmail: [3] } });
      expect(await s.service.editUser(s.req({ email, profile: { about: 'ok', location: 'x'.repeat(8001) } }))).toEqual({ handle: 'bob', errors: { email: reason, 'profile.location': 'max_length' } });
      expect(s.names()).not.toContain('userSetEmail');
      expect(s.named('profileSet')).toEqual([['profileSet', 8, 'about', 'ok']]);
    });
    test('a profile field of 8000 characters is fine', async () => {
      const s = setup();
      expect((await s.service.editUser(s.req({ profile: { about: 'x'.repeat(8000) } }))).errors).toEqual({});
    });
    test.each([
      [{ email: 5 }, { email: 'invalid' }], [{ profile: 'x' }, { profile: 'invalid' }], [{ profile: ['x'] }, { profile: 'invalid' }],
      [{ profile: { about: 5 } }, { 'profile.about': 'invalid' }],
    ])('%j is refused', async (body, fields) => {
      const s = setup();
      await rejectsWith(s.service.editUser(s.req(body)), 400, 'invalid_input', fields);
    });
    test('removing the avatar: both avatar flags, and the stored image when there is one', async () => {
      const s = setup({ target: { avatarblobid: '123' } });
      await s.service.editUser(s.req({ removeAvatar: true }));
      expect(s.named('userSetFlag', 'clearAvatar', 'blobDelete')).toEqual([['userSetFlag', 8, 4, false], ['userSetFlag', 8, 8, false], ['clearAvatar', 8], ['blobDelete', '123']]);
      const none = setup();
      await none.service.editUser(none.req({ removeAvatar: true }));
      expect(none.named('clearAvatar', 'blobDelete')).toEqual([]);
      const notTrue = setup({ target: { avatarblobid: '123' } });
      await notTrue.service.editUser(notTrue.req({ removeAvatar: 'yes' }));
      expect(notTrue.names()).not.toContain('blobDelete');
    });
    test('a moderator may remove an avatar but not edit the email or fields', async () => {
      const s = setup({ actor: 'mod' });
      expect(await s.service.editUser(s.req({ email: 'other@x.test', removeAvatar: true }))).toEqual({ handle: 'bob', errors: {} });
      expect(s.named('userSetEmail', 'profileSet', 'userWritten')).toEqual([]);
      expect(s.names()).toContain('userSetFlag');
    });
    test('someone who may not edit at all', async () => {
      await rejectsWith(setup({ actor: 'editor' }).service.editUser(setup().req({})), 403, 'edit_not_allowed');
      const self = setup({ target: { userid: 7 } });
      await rejectsWith(self.service.editUser(self.req({})), 403, 'edit_not_allowed');
    });
    test('an edit with no body', async () => {
      const s = setup();
      expect(await s.service.editUser(s.req(undefined))).toEqual({ handle: 'bob', errors: {} });
    });
  });

  describe('deleting a user (qa_delete_user())', () => {
    test('a blocked user below moderator: deleted, counts updated, the posts they voted on recounted', async () => {
      const s = setup({ target: { flags: 2 }, answers: { userVotedFlaggedPostids: [11, 12], postsUserids: [20, 21] } });
      expect(await s.service.deleteUser(s.req())).toEqual({ handle: 'bob', deleted: true });
      expect(s.calls.filter(([n]) => ['userDelete', 'userpointscountUpdate', 'uapprovecountUpdate', 'recountVotesAndFlags', 'postsUserids', 'updatePoints'].includes(n)).map(c => c.slice(0, 3))).toEqual([
        ['userDelete', 8], ['userpointscountUpdate', -1], ['recountVotesAndFlags', 11], ['recountVotesAndFlags', 12], ['postsUserids', [11, 12]],
        ['updatePoints', 20, ['avoteds', 'qvoteds', 'upvoteds', 'downvoteds']], ['updatePoints', 21, ['avoteds', 'qvoteds', 'upvoteds', 'downvoteds']],
      ]);
    });
    test('the approval count drops only for an unblocked user below "approved"; the points count only with points', async () => {
      const blockedNoPoints = setup({ target: { flags: 2, points: null }, answers: { userVotedFlaggedPostids: [], postsUserids: [] } });
      await blockedNoPoints.service.deleteUser(blockedNoPoints.req());
      expect(blockedNoPoints.named('userpointscountUpdate', 'uapprovecountUpdate')).toEqual([]);
      // a super admin may also delete users who are not blocked
      const s = setup({ actor: 'super', target: { flags: 2, level: 0, points: undefined }, answers: { userVotedFlaggedPostids: [], postsUserids: [] } });
      await s.service.deleteUser(s.req());
      expect(s.named('userpointscountUpdate')).toEqual([]);
    });
    test('only admins, and only for blocked users below moderator', async () => {
      await rejectsWith(setup({ target: { flags: 0 } }).service.deleteUser(setup().req()), 403, 'delete_not_allowed');
      await rejectsWith(setup({ actor: 'mod', target: { flags: 2 } }).service.deleteUser(setup().req()), 403, 'delete_not_allowed');
      await rejectsWith(setup({ actor: 'super', target: { flags: 2, level: 80 } }).service.deleteUser(setup().req()), 403, 'delete_not_allowed');
    });
  });

  describe('hiding all posts', () => {
    test('each post is hidden, or rejected when it is queued; posts already gone are skipped', async () => {
      const tried = [];
      const postChangeService = {
        setStatus: async ({ postid, body, token, ip }) => {
          tried.push([postid, body.action, token, ip]);
          if (postid === 2 && body.action === 'hide') throw Object.assign(new Error('queued'), { status: 403 });
          if (postid === 3) throw Object.assign(new Error('gone'), { status: 404 });
        },
      };
      const s = setup({ target: { flags: 2 }, postChangeService, answers: { userVisiblePostids: [1, 2, 3] } });
      expect(await s.service.hidePosts(s.req())).toEqual({ hidden: [1, 2] });
      expect(tried).toEqual([[1, 'hide', 'ok', '1.2.3.4'], [2, 'hide', 'ok', '1.2.3.4'], [2, 'reject', 'ok', '1.2.3.4'], [3, 'hide', 'ok', '1.2.3.4'], [3, 'reject', 'ok', '1.2.3.4']]);
      expect(s.named('userVisiblePostids')).toEqual([['userVisiblePostids', 8]]);
    });
    test('any other failure stops the run', async () => {
      const postChangeService = { setStatus: async () => { throw Object.assign(new Error('db'), { status: 503 }); } };
      const s = setup({ target: { flags: 2 }, postChangeService, answers: { userVisiblePostids: [1] } });
      await rejectsWith(s.service.hidePosts(s.req()), 503, undefined);
    });
    test('only for a removable user, by someone who may hide posts', async () => {
      await rejectsWith(setup({ target: { flags: 0 } }).service.hidePosts(setup().req()), 403, 'hide_not_allowed');
      await rejectsWith(setup({ target: { flags: 2 }, options: { permit_hide_show: '20' }, actor: 'mod' }).service.hidePosts(setup().req()), 403, 'hide_not_allowed');
    });
  });

  test('signed out, an account that no longer exists, or an unknown user', async () => {
    const s = setup();
    await rejectsWith(s.service.blockUser(s.req({}, 'bob', 'none')), 401, 'unauthenticated');
    await rejectsWith(s.service.blockUser(s.req({}, 'bob', 'ghost')), 401, 'unauthenticated');
    await rejectsWith(s.service.blockUser(s.req({}, 'nobody')), 404, 'user_not_found');
    await rejectsWith(s.service.blockUser(s.req({}, '')), 404, 'user_not_found');
  });
  test('rulesFor(): admins edit fields; nobody acts while blocked from writing', () => {
    const { rulesFor } = setup().service;
    const options = optionsWith(OPTIONS);
    expect(rulesFor(accounts.admin, { userid: 8, level: 0, flags: 0 }, [], options, '1.2.3.4')).toMatchObject({ fieldseditable: true, editable: true, manageable: true, removable: false, maxuserlevel: 0, loginlevel: 100 });
    expect(rulesFor({ ...accounts.admin, flags: 2 }, { userid: 8, level: 0, flags: 0 }, [], options, '1.2.3.4')).toMatchObject({ maxlevelassign: null, editable: false });
    expect(rulesFor(accounts.admin, { userid: 8, level: 0, flags: 0 }, [], optionsWith({ ...OPTIONS, block_ips_write: '1.2.3.4' }), '1.2.3.4')).toMatchObject({ maxlevelassign: null });
    expect(rulesFor(accounts.mod, { userid: 8, level: 10, flags: 0 }, [], options).adminApprove).toBe(true);
    expect(rulesFor(accounts.mod, { userid: 8, level: 11, flags: 0 }, [], options).adminApprove).toBe(false);
    expect(rulesFor(accounts.admin, { userid: 8, level: 50, flags: 0 }, [{ level: '80' }], options)).toMatchObject({ maxuserlevel: 80, manageable: false });
  });
});
