// src/q2a/permissions.js against Q2A's own PHP functions: every case in php-permissions-outputs.json was run
// through the PHP original in the PHP container (tests/fixtures/php-permissions.php, scripts/php-fixtures.sh),
// and the Node port must give the same answer for the same inputs.
//
// Each test checks a whole table of cases and lists every case where Node differs, so one failure shows all
// the mismatches at once (and mutation testing runs a dozen tests per change rather than thousands).
const php = require('../fixtures/php-permissions-outputs.json');
const {
  permitValueError, permitError, limitsRemaining, blockIpMatch, isIpBlocked, userPermitError,
  userLevelForPost, userLevelForCategories, userLevelMaximum, moderationReason, postIsByUser, LIMIT,
} = require('../../src/q2a/permissions');

// The options object the services pass around: get() and the database time, as loadOptions() builds it.
const optionsWith = (overrides = {}) => {
  const values = { ...php.baseOptions, ...overrides };
  return { get: name => values[name], dbTime: Number(values.db_time) };
};
// Inputs a real request never has, where PHP's loose comparisons with null give a different answer:
// - points null: Node loads the acting user with COALESCE(points, 0) (repositories/shared.js), and PHP creates
//   the missing qa_userpoints row before it checks (qa_get_logged_in_user_cache()). PHP 8 compares null >= '0'
//   as '' >= '0', which is false; Node compares 0 >= 0.
// - level null with a category level of 0: qa_users.level is NOT NULL. PHP's max(null, 0) returns null.
const unreachablePoints = (userid, points) => userid !== null && points === null;
const unreachableLevel = (level, set) => level === null && Object.values(set).includes(0);
const categoryLevels = set => new Map(Object.entries(set).map(([id, level]) => [Number(id), level]));

// Runs every case and returns the ones where Node's answer is not PHP's: [inputs, php, node].
function mismatches(cases, run) {
  const wrong = [];
  for (const row of cases) {
    const expected = row.at(-1);
    let actual;
    try { actual = run(...row.slice(0, -1)); } catch (error) { actual = `threw ${error.message}`; }
    if (actual !== expected) wrong.push({ inputs: row.slice(0, -1), php: expected, node: actual });
  }
  return wrong;
}

test('the PHP cases are all there', () => {
  for (const name of ['permitValueError', 'permitError', 'limitsRemaining', 'blockIpMatch', 'isIpBlocked', 'userPermitError',
    'userLevelForPost', 'userLevelForCategories', 'userLevelMaximum', 'moderationReason', 'postIsByUser']) {
    expect(php[name].length).toBeGreaterThan(10);
  }
});

test('qa_permit_value_error()', () => {
  expect(mismatches(php.permitValueError, (permit, userid, level, flags, confirm, moderate) =>
    permitValueError(permit, userid === null ? null : { userid, flags }, level, optionsWith({ confirm_user_emails: confirm, moderate_users: moderate }))))
    .toEqual([]);
});

test('a missing level counts as level 0, as PHP compares null with numbers', () => {
  // qa_permit_value_error() with $userlevel null: null < QA_USER_LEVEL_EXPERT is true in PHP.
  const user = { userid: 5, flags: 0 };
  expect(permitValueError(100, user, undefined, optionsWith())).toBe('level');
  expect(permitValueError(100, user, null, optionsWith())).toBe('level');
  expect(permitValueError(120, user, undefined, optionsWith())).toBe(false);
});

describe('qa_permit_error()', () => {
  test('matches PHP, including the points rules', () => {
    const cases = php.permitError.filter(([, , , userid, , , points]) => !unreachablePoints(userid, points));
    expect(mismatches(cases, (permit, threshold, confirm, userid, level, flags, points) =>
      permitError('permit_x', userid === null ? null : { userid, flags, points }, level,
        optionsWith({ permit_x: permit, permit_x_points: threshold, confirm_user_emails: confirm, moderate_users: '1' }))))
      .toEqual([]);
  });
  test('with no permission option, anyone may act unless blocked', () => {
    const [[, anonymous], [, blocked]] = php.permitErrorNoOption;
    expect(permitError(null, null, null, optionsWith())).toBe(anonymous);
    expect(permitError(null, { userid: 5, flags: 2 }, 0, optionsWith())).toBe(blocked);
  });
});

describe('qa_limits_calc_remaining()', () => {
  const kinds = { Q: 'qs', A: 'as', C: 'cs', V: 'votes', U: 'uploads', F: 'flags', M: 'messages', W: 'messages' };
  test('matches PHP for every limited action', () => {
    expect(mismatches(php.limitsRemaining, (action, userMax, ipMax, userRow, ipRow) =>
      limitsRemaining(action, userRow ?? undefined, ipRow ?? undefined,
        optionsWith({ [`max_rate_user_${kinds[action]}`]: userMax, [`max_rate_ip_${kinds[action]}`]: ipMax }))))
      .toEqual([]);
  });
  test('every limited action Node checks is in the PHP cases', () => {
    const checked = new Set(php.limitsRemaining.map(([action]) => action));
    for (const action of Object.values(LIMIT)) if (!['R', 'L'].includes(action)) expect(checked).toContain(action);
  });
});

test('qa_block_ip_match()', () => {
  expect(mismatches(php.blockIpMatch, blockIpMatch)).toEqual([]);
});

test('qa_is_ip_blocked()', () => {
  expect(mismatches(php.isIpBlocked, (list, ip) => isIpBlocked(ip, optionsWith({ block_ips_write: list })))).toEqual([]);
});

describe('qa_user_permit_error()', () => {
  test('matches PHP for permissions, IP blocks and required confirmation', () => {
    expect(mismatches(php.userPermitError, (permit, confirm, blocked, user, userlevel) =>
      userPermitError({ permitoption: 'permit_x', userlevel, user, ip: '1.2.3.4',
        options: optionsWith({ permit_x: permit, confirm_user_emails: confirm, block_ips_write: blocked }) })))
      .toEqual([]);
  });

  // PHP's limit check reads the database, so it is not in the PHP cases; this is qa_user_permit_error()'s
  // last step: an action with no allowance left is refused with 'limit', and only when nothing else is wrong.
  const user = { userid: 5, level: 0, flags: 0, points: 0 };
  const limitOptions = { permit_x: 150, max_rate_user_qs: '5', max_rate_ip_qs: '5' };
  const period = Math.trunc(optionsWith().dbTime / 3600);
  const check = (limits, extra = {}, who = user) =>
    userPermitError({ permitoption: 'permit_x', limitAction: 'Q', user: who, ip: '9.9.9.9', options: optionsWith({ ...limitOptions, ...extra }), limits });
  test.each([
    ['allowance left', { user: { period, count: 4 } }, false],
    ['allowance used up by the user', { user: { period, count: 5 } }, 'limit'],
    ['allowance used up by the IP', { ip: { period, count: 7 } }, 'limit'],
    ['counts from an earlier hour', { user: { period: period - 1, count: 9 } }, false],
    ['no limit rows yet', undefined, false],
  ])('limit action with %s', (label, limits, expected) => {
    expect(check(limits)).toBe(expected);
  });
  test('no allowance at all is refused even without limit rows', () => {
    expect(check(undefined, { max_rate_user_qs: '0' })).toBe('limit');
  });
  test('a permission error comes before the limit', () => {
    const usedUp = { user: { period, count: 5 } };
    expect(check(usedUp, {}, { ...user, flags: 2 })).toBe('userblock');
    expect(check(usedUp, { block_ips_write: '9.9.9.9' })).toBe('ipblock');
  });
  test('no limit action means no limit check', () => {
    expect(userPermitError({ permitoption: 'permit_x', user, ip: '9.9.9.9', options: optionsWith(limitOptions), limits: { user: { period, count: 99 } } })).toBe(false);
  });
});

describe('category levels', () => {
  // A null level stands for a user with no level of their own; PHP's max() treats it as 0.
  test('qa_user_level_for_post()', () => {
    const cases = php.userLevelForPost.filter(([level, set]) => !unreachableLevel(level, set));
    expect(mismatches(cases, (level, set, categoryids) => userLevelForPost({ categoryids }, { level, categoryLevels: categoryLevels(set) }))).toEqual([]);
  });
  test('qa_user_level_for_categories()', () => {
    const cases = php.userLevelForCategories.filter(([level, set]) => !unreachableLevel(level, set));
    expect(mismatches(cases, (level, set, ids) => userLevelForCategories(ids, { level, categoryLevels: categoryLevels(set) }))).toEqual([]);
  });
  test('qa_user_level_maximum()', () => {
    const cases = php.userLevelMaximum.filter(([level, set]) => !unreachableLevel(level, set));
    expect(mismatches(cases, (level, set) => userLevelMaximum({ level, categoryLevels: categoryLevels(set) }))).toEqual([]);
  });
  test('a user without category levels keeps their own level', () => {
    expect(userLevelForPost({ categoryids: '3' }, { level: 20 })).toBe(20);
    expect(userLevelForCategories([3], { level: 20 })).toBe(20);
    expect(userLevelMaximum({ level: 20 })).toBe(20);
  });
  test('a signed-out visitor has no level, as PHP gives for no logged-in user', () => {
    expect(userLevelForPost({ categoryids: '3,4' }, null)).toBe(null);
    expect(userLevelForPost({ categoryids: '' }, null)).toBe(null);
    expect(userLevelForCategories([3, 4], null)).toBe(null);
    expect(userLevelForCategories([], undefined)).toBe(null);
    expect(userLevelMaximum(null)).toBe(null);
  });
});

test('qa_user_moderation_reason()', () => {
  expect(mismatches(php.moderationReason, (opts, user, level) => moderationReason(level, user, '1.2.3.4', optionsWith(opts)))).toEqual([]);
});

test('qa_post_is_by_user()', () => {
  expect(mismatches(php.postIsByUser, postIsByUser)).toEqual([]);
});
