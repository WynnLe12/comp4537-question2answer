// The auth, vote and favorite services driven directly, with the repository replaced: every rule and
// every write they make. The parity suites hold the same services to the PHP site; these pin each rule.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createHash } = require('node:crypto');
const { createAuthService, registrationInput, verifyPassword, postText } = require('../../src/services/auth');
const { createVoteService } = require('../../src/services/votes');
const { createFavoriteService, ENTITY_TYPES } = require('../../src/services/favorites');
const { fakeRepository, optionsWith, rejectsWith } = require('./fake-repository');

const jwtSecret = 'x'.repeat(32);
const sign = (claims, opts = {}) => jwt.sign(claims, jwtSecret, { algorithm: 'HS256', issuer: 'q2a-node-api', audience: 'q2a-auth', subject: '1', jwtid: 'a'.repeat(32), expiresIn: 60, ...opts });
const sha256 = value => createHash('sha256').update(value).digest('hex');

describe('auth: configuration', () => {
  test('the signing secret needs at least 32 bytes', () => {
    expect(() => createAuthService({}, { jwtSecret: 'x'.repeat(31) })).toThrow('AUTH_JWT_SECRET');
    expect(() => createAuthService({}, { jwtSecret: 'é'.repeat(16) })).not.toThrow(); // 32 bytes in UTF-8
    expect(() => createAuthService({}, { jwtSecret: 12345678901234567890123456789012 })).toThrow('AUTH_JWT_SECRET');
    expect(() => createAuthService({})).toThrow('AUTH_JWT_SECRET');
  });
  test.each([4, 10, 31])('bcrypt cost %i is allowed', saltRounds => {
    expect(() => createAuthService({}, { jwtSecret, saltRounds })).not.toThrow();
  });
});

describe('auth: registration input (pages/register.php)', () => {
  const valid = { handle: 'newuser', email: 'new@example.test', password: 'Password1' };
  test('a valid registration passes through trimmed', () => {
    expect(registrationInput(valid)).toEqual(valid);
  });
  test.each([
    ['handle of 20 characters', { handle: 'h'.repeat(20) }, null],
    ['handle of 21 characters', { handle: 'h'.repeat(21) }, { handle: 'invalid' }],
    ['handle "anonymous" inside other words', { handle: 'my anonymous self' }, { handle: 'invalid' }],
    ['handle containing "anonymously"', { handle: 'anonymously' }, null],
    ['handle that is only control characters', { handle: '\u0000\u0007' }, { handle: 'invalid' }],
    ['password of 8 characters', { password: '12345678' }, null],
    ['password of 7 characters', { password: '1234567' }, { password: 'too_short' }],
    ['password of 8 characters counted by code point', { password: '😀😀😀😀😀😀😀😀' }, null],
    ['empty email', { email: '' }, { email: 'invalid' }],
    ['invalid email', { email: 'not-an-email' }, { email: 'invalid' }],
    ['email of 80 characters', { email: `a@${'d'.repeat(60)}.${'e'.repeat(12)}.test` }, null],
    ['email of 81 characters', { email: `a@${'d'.repeat(60)}.${'e'.repeat(13)}.test` }, { email: 'invalid' }],
    ['everything wrong', { handle: '', email: '', password: '' }, { handle: 'invalid', email: 'invalid', password: 'too_short' }],
  ])('%s', (label, change, fields) => {
    if (fields) {
      try { registrationInput({ ...valid, ...change }); throw new Error('accepted'); } catch (error) {
        expect(error).toMatchObject({ status: 400, code: 'validation_failed', fields });
      }
    } else {
      expect(() => registrationInput({ ...valid, ...change })).not.toThrow();
    }
  });
  test('postText() trims PHP whitespace, normalises line breaks and refuses non-strings', () => {
    expect(postText(undefined)).toBe('');
    expect(postText(null)).toBe('');
    expect(postText('\0\x0B a\r\nb\rc \t')).toBe('a\nb\nc');
    expect(() => postText(5)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_input' }));
  });
});

describe('auth: passwords', () => {
  const salt = 'abcdefgh12345678';
  const legacy = password => createHash('sha1').update(salt.slice(0, 8) + password + salt.slice(8)).digest();
  test('a legacy hash may be given as hex text', async () => {
    expect(await verifyPassword({ passsalt: salt, passcheck: legacy('pw').toString('hex') }, 'pw')).toEqual({ valid: true, rehash: true });
    expect(await verifyPassword({ passsalt: salt, passcheck: legacy('pw').toString('hex') }, 'pW')).toEqual({ valid: false, rehash: false });
  });
  test('a legacy hash of the wrong length never matches', async () => {
    expect((await verifyPassword({ passsalt: salt, passcheck: Buffer.from('abcd', 'hex') }, 'pw')).valid).toBe(false);
  });
  test('without a salt or a check value the legacy hash is not used', async () => {
    expect((await verifyPassword({ passsalt: salt, passcheck: null }, 'pw')).valid).toBe(false);
    expect((await verifyPassword({ passsalt: null, passcheck: legacy('pw') }, 'pw')).valid).toBe(false);
  });
  test('a bcrypt hash at another cost is upgraded; at the configured cost it is not', async () => {
    const hash = await bcrypt.hash('pw', 4);
    expect(await verifyPassword({ passhash: hash }, 'pw', 5)).toEqual({ valid: true, rehash: true });
    expect(await verifyPassword({ passhash: hash }, 'pw', 4)).toEqual({ valid: true, rehash: false });
    expect(await verifyPassword({ passhash: hash }, 'wrong', 5)).toEqual({ valid: false, rehash: false });
    expect(await verifyPassword({}, 'pw')).toEqual({ valid: false, rehash: false });
  });
});

describe('auth: sessions', () => {
  let alice, repo, service;
  beforeEach(async () => {
    alice = { userid: 1, handle: 'alice', email: 'alice@example.test', level: 20, flags: 3, passhash: await bcrypt.hash('Password1', 4), points: 9 };
    repo = {
      find: jest.fn(async (field, value) => (alice[field] === value ? [alice] : [])),
      upgradePassword: jest.fn(), createSession: jest.fn(), deleteSession: jest.fn(),
      findSession: jest.fn(async () => alice), findById: jest.fn(async id => (id === 1 ? alice : null)),
      createUser: jest.fn(async input => ({ ...alice, handle: input.handle, email: input.email, emails: [], options: optionsWith() })),
    };
    service = createAuthService(repo, { jwtSecret, saltRounds: 4 });
  });

  test('login by handle: a one-day session, recorded by its token hash, with the public fields only', async () => {
    const result = await service.login({ emailhandle: ' alice ', password: 'Password1' }, '1.2.3.4');
    expect(repo.find).toHaveBeenCalledWith('handle', 'alice');
    expect(result).toMatchObject({ user: { id: 1, handle: 'alice', email: 'alice@example.test', level: 20, flags: 3 }, ttl: 86400, remember: false });
    expect(Object.keys(result.user)).toEqual(['id', 'handle', 'email', 'level', 'flags']);
    expect(repo.createSession).toHaveBeenCalledWith(1, sha256(result.token), 86400, '1.2.3.4');
    const claims = jwt.verify(result.token, jwtSecret);
    expect(claims).toMatchObject({ sub: '1', iss: 'q2a-node-api', aud: 'q2a-auth' });
    expect(claims.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(claims.exp - claims.iat).toBe(86400);
  });
  test('login by email; "remember me" (exactly true) gives 30 days', async () => {
    const result = await service.login({ emailhandle: 'alice@example.test', password: 'Password1', remember: true }, 'ip');
    expect(repo.find).toHaveBeenCalledWith('email', 'alice@example.test');
    expect(result).toMatchObject({ ttl: 30 * 86400, remember: true });
    expect((await service.login({ emailhandle: 'alice', password: 'Password1', remember: 'true' }, 'ip')).remember).toBe(false);
  });
  test('a missing handle or password is a validation error before any lookup', async () => {
    await rejectsWith(service.login({ emailhandle: 'alice' }, 'ip'), 400, 'validation_failed');
    await rejectsWith(service.login({ password: 'x' }, 'ip'), 400, 'validation_failed');
    expect(repo.find).not.toHaveBeenCalled();
  });
  test('an identifier matching two accounts is refused like an unknown one', async () => {
    repo.find.mockResolvedValue([alice, { ...alice, userid: 2 }]);
    await rejectsWith(service.login({ emailhandle: 'alice', password: 'Password1' }, 'ip'), 401, 'invalid_credentials');
    expect(repo.createSession).not.toHaveBeenCalled();
  });
  test('unknown users still cost a bcrypt comparison, with one dummy hash reused', async () => {
    const hash = jest.spyOn(bcrypt, 'hash');
    const compare = jest.spyOn(bcrypt, 'compare');
    try {
      await rejectsWith(service.login({ emailhandle: 'nobody', password: 'x' }, 'ip'), 401, 'invalid_credentials');
      await rejectsWith(service.login({ emailhandle: 'nobody', password: 'y' }, 'ip'), 401, 'invalid_credentials');
      expect(hash).toHaveBeenCalledTimes(1);
      expect(compare).toHaveBeenCalledTimes(2);
    } finally { hash.mockRestore(); compare.mockRestore(); }
  });
  test('a correct password at the configured cost is not rehashed; a legacy one is', async () => {
    await service.login({ emailhandle: 'alice', password: 'Password1' }, 'ip');
    expect(repo.upgradePassword).not.toHaveBeenCalled();
    const salt = 'abcdefgh12345678';
    Object.assign(alice, { passhash: null, passsalt: salt, passcheck: createHash('sha1').update(`${salt.slice(0, 8)}Password1${salt.slice(8)}`).digest() });
    await service.login({ emailhandle: 'alice', password: 'Password1' }, 'ip');
    expect(repo.upgradePassword).toHaveBeenCalledWith(1, expect.stringMatching(/^\$2[aby]\$04\$/));
  });
  test('registration stores a bcrypt hash, sends its emails after, and signs in for one day', async () => {
    const options = optionsWith({ smtp_active: '' });
    repo.createUser.mockImplementation(async input => ({ ...alice, userid: 5, handle: input.handle, emails: [{ toemail: 'a@x.test' }, { toemail: 'b@x.test' }], options }));
    const result = await service.register({ handle: 'newbie', email: 'n@example.test', password: 'Password1' }, '5.6.7.8');
    const [input, ip] = repo.createUser.mock.calls[0];
    expect(input).toMatchObject({ handle: 'newbie', email: 'n@example.test', password: 'Password1' });
    expect(await bcrypt.compare('Password1', input.hash)).toBe(true);
    expect(ip).toBe('5.6.7.8');
    expect(result).toMatchObject({ user: { id: 5, handle: 'newbie' }, ttl: 86400, remember: false });
    expect(result.user).not.toHaveProperty('emails');
    expect(result.user).not.toHaveProperty('options');
    expect(repo.createSession).toHaveBeenCalledWith(5, expect.any(String), 86400, '5.6.7.8');
  });
  test('registration with no emails to send', async () => {
    repo.createUser.mockImplementation(async input => ({ userid: 6, handle: input.handle, email: input.email, level: 0, flags: 0 }));
    expect((await service.register({ handle: 'quiet', email: 'q@example.test', password: 'Password1' }, 'ip')).user.id).toBe(6);
  });

  describe('me()', () => {
    test('a valid token whose session belongs to its user', async () => {
      const token = sign({});
      expect(await service.me(token)).toEqual({ id: 1, handle: 'alice', email: 'alice@example.test', level: 20, flags: 3 });
      expect(repo.findSession).toHaveBeenCalledWith(sha256(token));
    });
    test('a session that belongs to someone else, or none at all', async () => {
      repo.findSession.mockResolvedValueOnce({ ...alice, userid: 2 });
      await rejectsWith(service.me(sign({})), 401, 'unauthenticated');
      repo.findSession.mockResolvedValueOnce(undefined);
      await rejectsWith(service.me(sign({})), 401, 'unauthenticated');
    });
    test.each([
      ['not a string', 12345],
      ['too long', `${'a'.repeat(1000)}.${'b'.repeat(1000)}.${'c'.repeat(100)}`],
      ['not three parts', 'abc.def'],
      ['characters outside base64url', 'a+b.c/d.e=f'],
      ['signed with another secret', jwt.sign({}, 'y'.repeat(32), { algorithm: 'HS256', issuer: 'q2a-node-api', audience: 'q2a-auth', subject: '1', jwtid: 'a'.repeat(32), expiresIn: 60 })],
      ['another algorithm', jwt.sign({}, jwtSecret, { algorithm: 'HS512', issuer: 'q2a-node-api', audience: 'q2a-auth', subject: '1', jwtid: 'a'.repeat(32), expiresIn: 60 })],
      ['another issuer', sign({}, { issuer: 'someone-else' })],
      ['a subject that is not a user ID', sign({}, { subject: 'admin' })],
      ['a token ID that is not 32 hex digits', sign({}, { jwtid: 'short' })],
      ['a token ID in capitals', sign({}, { jwtid: 'A'.repeat(32) })],
      ['no expiry', jwt.sign({}, jwtSecret, { algorithm: 'HS256', issuer: 'q2a-node-api', audience: 'q2a-auth', subject: '1', jwtid: 'a'.repeat(32) })],
    ])('a token %s is refused without a session lookup', async (label, token) => {
      await rejectsWith(service.me(token), 401, 'unauthenticated');
      expect(repo.findSession).not.toHaveBeenCalled();
    });
  });

  test('startSession() signs in a known user for one day', async () => {
    expect(await service.startSession(1, 'ip')).toMatchObject({ user: { id: 1 }, ttl: 86400, remember: false });
    await rejectsWith(service.startSession(99, 'ip'), 401, 'unauthenticated');
  });
  test('logout() deletes the session only for a valid token', async () => {
    const token = sign({});
    await service.logout(token);
    expect(repo.deleteSession).toHaveBeenCalledWith(sha256(token));
    await service.logout('garbage');
    await service.logout(undefined);
    expect(repo.deleteSession).toHaveBeenCalledTimes(1);
  });
});

describe('votes (app/votes.php)', () => {
  const OPTIONS = { voting_on_qs: '1', voting_on_as: '1', voting_on_cs: '1', permit_vote_q: '120', permit_vote_a: '120', permit_vote_down: '120', max_rate_user_votes: '100', max_rate_ip_votes: '100', confirm_user_emails: '1' };
  const voter = { userid: 7, level: 0, flags: 1, points: 100 };
  function setup({ post = {}, vote, question = {}, options = {}, user = voter, limits = {} } = {}) {
    const fake = fakeRepository({
      loadOptions: optionsWith({ ...OPTIONS, ...options }),
      findPost: id => (id === 5 ? { postid: 5, type: 'Q', basetype: 'Q', hidden: 0, queued: 0, userid: 9, parentid: null, netvotes: 0, categoryids: '', ...post } : undefined),
      findVoter: id => (id === 7 ? user : null),
      findLimits: limits,
      getUserVote: vote === undefined ? undefined : { vote },
      findQuestion: { postid: 1, amaxvote: 0, closedbyid: null, acount: 1, ...question },
      setAmaxvote: 1,
      postVotes: { upvotes: 2, downvotes: 1, netvotes: 1 },
    });
    const service = createVoteService(fake.repository, { identify: async token => (token === 'ok' ? { id: 7 } : null) });
    return { ...fake, vote: (v, token = 'ok', postid = 5) => service.vote({ token, postid, vote: v, ip: '1.2.3.4' }) };
  }

  test('a vote returns the new counts', async () => {
    expect(await setup().vote(1)).toEqual({ vote: 1, post: { id: 5, upvotes: 2, downvotes: 1, netvotes: 1 } });
  });
  test.each([
    ['questions', { type: 'Q', basetype: 'Q' }, 'voting_on_qs'],
    ['answers', { type: 'A', basetype: 'A', parentid: 1 }, 'voting_on_as'],
    ['comments', { type: 'C', basetype: 'C', parentid: 1 }, 'voting_on_cs'],
  ])('voting on %s follows its option', async (label, post, option) => {
    await expect(setup({ post }).vote(1)).resolves.toBeTruthy();
    await rejectsWith(setup({ post, options: { [option]: '0' } }).vote(1), 403, 'vote_not_allowed');
  });
  test('a post of another kind cannot be voted on', async () => {
    await rejectsWith(setup({ post: { type: 'Q_HIDDEN', basetype: 'X' } }).vote(1), 403, 'vote_not_allowed');
  });
  test('an anonymous post can be voted on; your own cannot', async () => {
    await expect(setup({ post: { userid: null } }).vote(1)).resolves.toBeTruthy();
    await rejectsWith(setup({ post: { userid: '7' } }).vote(1), 403, 'vote_not_allowed');
  });
  test('no post ID means no post', async () => {
    const s = setup();
    await rejectsWith(s.vote(1, 'ok', null), 404, 'post_not_found');
    expect(s.names()).not.toContain('findPost');
  });
  test('comments are voted under permit_vote_a, as in PHP', async () => {
    await rejectsWith(setup({ post: { type: 'C', basetype: 'C', parentid: 1 }, options: { permit_vote_a: '100' } }).vote(1), 403, 'no_permission');
    await expect(setup({ post: { type: 'C', basetype: 'C', parentid: 1 }, options: { permit_vote_q: '100' } }).vote(1)).resolves.toBeTruthy();
    await rejectsWith(setup({ options: { permit_vote_q: '100' } }).vote(1), 403, 'no_permission');
  });
  test('down votes also need permit_vote_down; up votes and taking a vote back do not', async () => {
    const options = { permit_vote_down: '100' };
    await rejectsWith(setup({ options }).vote(-1), 403, 'no_permission');
    await expect(setup({ options }).vote(1)).resolves.toBeTruthy();
    await expect(setup({ options, vote: 1 }).vote(0)).resolves.toBeTruthy();
  });
  test('unconfirmed users are told to confirm, with the down-vote message for a down vote', async () => {
    const user = { ...voter, flags: 0 };
    await rejectsWith(setup({ user, options: { permit_vote_q: '110' } }).vote(1), 403, 'vote_must_confirm');
    await rejectsWith(setup({ user, options: { permit_vote_down: '110' } }).vote(-1), 403, 'vote_down_must_confirm');
    await rejectsWith(setup({ user, options: { permit_vote_q: '110' } }).vote(-1), 403, 'vote_must_confirm');
  });
  test('signed-out voters are asked to log in, even when the post allows anyone', async () => {
    await rejectsWith(setup().vote(1, 'none'), 401, 'unauthenticated');
    const s = setup({ options: { permit_vote_q: '150', permit_vote_down: '150' } });
    await rejectsWith(s.vote(1, 'none'), 401, 'unauthenticated');
    expect(s.names()).not.toContain('setUserVote');
    expect(s.named('findLimits')[0]).toEqual(['findLimits', undefined, '1.2.3.4', 'V']);
  });

  describe('qa_vote_set()', () => {
    test('a new up vote on a question: counts, the voter\'s and author\'s points, hotness, limits, last write', async () => {
      const s = setup();
      await s.vote(1);
      expect(s.calls.filter(([n]) => !['loadOptions', 'findPost', 'findVoter', 'findLimits', 'postVotes'].includes(n)).map(([n, ...a]) => [n, ...a.filter(x => typeof x !== 'object' || Array.isArray(x))])).toEqual([
        ['getUserVote', 5, 7], ['setUserVote', 5, 7, 1], ['recountVotes', 5],
        ['updatePoints', 7, ['qupvotes']], ['updatePoints', 9, ['qvoteds', 'upvoteds', 'downvoteds']],
        ['updateHotness', 5], ['incrementLimits', 7, '1.2.3.4', 'V', 2000], ['userWritten', 7, '1.2.3.4'],
      ]);
    });
    test('changing a vote from down to up updates both point columns', async () => {
      const s = setup({ vote: -1 });
      await s.vote(1);
      expect(s.named('updatePoints')[0].slice(0, 3)).toEqual(['updatePoints', 7, ['qupvotes', 'qdownvotes']]);
    });
    test('taking back a down vote updates only the down column; a comment updates the comment columns and no hotness', async () => {
      const s = setup({ vote: -1, post: { type: 'C', basetype: 'C', parentid: 1 } });
      await s.vote(0);
      expect(s.named('updatePoints').map(c => c.slice(1, 3))).toEqual([[7, ['cdownvotes']], [9, ['cvoteds', 'upvoteds', 'downvoteds']]]);
      expect(s.names()).not.toContain('updateHotness');
      expect(s.names()).not.toContain('findQuestion');
    });

    // An answer's vote can change the question's best answer score (amaxvote) and the count of questions
    // with no up-voted answer.
    const amax = async (...args) => {
      const s = setup({ post: { type: 'A', basetype: 'A', parentid: 1, netvotes: args[0] }, question: args[1], vote: args[3] });
      await s.vote(args[2]);
      return { amax: s.named('setAmaxvote').map(c => c.slice(1)), unupaq: s.named('unupaqcountUpdate').map(c => c[1]) };
    };
    test('the first up vote on any answer raises amaxvote and the question leaves the unanswered count', async () => {
      expect(await amax(0, { amaxvote: 0 }, 1)).toEqual({ amax: [[1, 1]], unupaq: [-1] });
    });
    test('a closed question is not in the unanswered count', async () => {
      expect(await amax(0, { amaxvote: 0, closedbyid: 4 }, 1)).toEqual({ amax: [[1, 1]], unupaq: [] });
    });
    test('beating an existing best score only raises it', async () => {
      expect(await amax(2, { amaxvote: 2 }, 1)).toEqual({ amax: [[1, 3]], unupaq: [] });
    });
    test('a vote that stays below the best score changes nothing', async () => {
      expect(await amax(0, { amaxvote: 2 }, 1)).toEqual({ amax: [], unupaq: [] });
      expect(await amax(1, { amaxvote: 2 }, -1)).toEqual({ amax: [], unupaq: [] });
    });
    test('the only answer losing its score lowers amaxvote, and returns the question to the count at 0', async () => {
      expect(await amax(1, { amaxvote: 1, acount: 1 }, 0, 1)).toEqual({ amax: [[1, 0]], unupaq: [1] });
      expect(await amax(2, { amaxvote: 2, acount: 1 }, 0, 1)).toEqual({ amax: [[1, 1]], unupaq: [] });
      expect(await amax(1, { amaxvote: 1, acount: 1, closedbyid: 3 }, 0, 1)).toEqual({ amax: [[1, 0]], unupaq: [] });
    });
    test('with other answers, amaxvote is recounted from all of them', async () => {
      expect(await amax(1, { amaxvote: 1, acount: 3 }, 0, 1)).toEqual({ amax: [[1]], unupaq: [1] });
      expect(await amax(2, { amaxvote: 2, acount: 3 }, 0, 1)).toEqual({ amax: [[1]], unupaq: [] });
    });
    test('a recount that changes nothing leaves the count alone', async () => {
      const fake = fakeRepository({
        loadOptions: optionsWith(OPTIONS), findPost: { postid: 5, type: 'A', basetype: 'A', hidden: 0, queued: 0, userid: 9, parentid: 1, netvotes: 1, categoryids: '' },
        findVoter: voter, findLimits: {}, getUserVote: { vote: 1 }, findQuestion: { postid: 1, amaxvote: 1, closedbyid: null, acount: 3 }, setAmaxvote: 0, postVotes: {},
      });
      await createVoteService(fake.repository, { identify: async () => ({ id: 7 }) }).vote({ token: 'ok', postid: 5, vote: 0, ip: 'ip' });
      expect(fake.named('unupaqcountUpdate')).toEqual([]);
    });
    test('the potential score never goes below zero', async () => {
      expect(await amax(0, { amaxvote: 0 }, -1)).toEqual({ amax: [], unupaq: [] });
    });
    test('an answer\'s points use the answer columns and no hotness', async () => {
      const s = setup({ post: { type: 'A', basetype: 'A', parentid: 1 } });
      await s.vote(-1);
      expect(s.named('updatePoints').map(c => c.slice(1, 3))).toEqual([[7, ['adownvotes']], [9, ['avoteds', 'upvoteds', 'downvoteds']]]);
      expect(s.names()).not.toContain('updateHotness');
    });
  });
});

describe('favorites (app/favorites.php)', () => {
  const setup = (user = { userid: 7 }) => {
    const fake = fakeRepository({ loadOptions: optionsWith({ a: '1' }), findActor: id => (id === 7 ? user : null) });
    const service = createFavoriteService(fake.repository, { identify: async token => (token === 'ok' ? { id: 7 } : token === 'ghost' ? { id: 8 } : null) });
    return { ...fake, service };
  };
  test('the four kinds of thing, by their URL names', () => {
    expect(ENTITY_TYPES).toEqual({ questions: 'Q', users: 'U', tags: 'T', categories: 'C' });
  });
  test.each(Object.entries(ENTITY_TYPES))('favoriting %s and taking it back', async (type, code) => {
    const s = setup();
    expect(await s.service.favorite({ token: 'ok', type, entityid: 12, ip: 'ip' })).toEqual({ entityType: type, entityId: 12, favorite: true });
    expect(await s.service.unfavorite({ token: 'ok', type, entityid: 12, ip: 'ip' })).toEqual({ entityType: type, entityId: 12, favorite: false });
    expect(s.calls.filter(([n]) => n !== 'loadOptions' && n !== 'findActor').map(c => c.filter(x => typeof x !== 'object'))).toEqual([
      ['favoriteCreate', 7, code, 12], ['userWritten', 7, 'ip'], ['favoriteDelete', 7, code, 12], ['userWritten', 7, 'ip'],
    ]);
    expect(s.named('favoriteCreate')[0][4].get('a')).toBe('1'); // the options go to qa_db_favorite_create()
  });
  test('refusals, checked in order: unknown kind, missing ID, signed out, unknown user, yourself', async () => {
    const s = setup();
    await rejectsWith(s.service.favorite({ token: 'none', type: 'posts', entityid: 1 }), 404, 'not_found');
    await rejectsWith(s.service.favorite({ token: 'none', type: 'users', entityid: null }), 400, 'invalid_input', { entityid: 'invalid' });
    await rejectsWith(s.service.favorite({ token: 'none', type: 'users', entityid: 3 }), 401, 'unauthenticated');
    await rejectsWith(s.service.favorite({ token: 'ghost', type: 'users', entityid: 3 }), 401, 'unauthenticated');
    await rejectsWith(s.service.favorite({ token: 'ok', type: 'users', entityid: 7 }), 403, 'favorite_not_allowed');
    await rejectsWith(s.service.unfavorite({ token: 'ok', type: 'users', entityid: 7 }), 403, 'favorite_not_allowed');
    expect(s.named('favoriteCreate', 'favoriteDelete', 'userWritten')).toEqual([]);
  });
  test('another user, or a question with your own ID, is fine', async () => {
    const s = setup({ userid: '7' });
    await s.service.favorite({ token: 'ok', type: 'users', entityid: 8 });
    await s.service.favorite({ token: 'ok', type: 'questions', entityid: 7 });
    expect(s.named('favoriteCreate')).toHaveLength(2);
  });
});
