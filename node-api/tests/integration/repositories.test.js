// The repositories (src/repositories/*.js): every method run inside a transaction on a recording connection,
// with sample arguments chosen from each parameter's name. Each method's statements (SQL and parameters,
// in order) and its result are a Jest snapshot. The parity suites run these same statements against MySQL
// and compare every row they change with PHP's, so the snapshots record SQL that matches PHP's; update
// them (npx jest -u) only for a change those suites accept. The transaction wrapper is tested directly.
const { createTransactor } = require('../../src/repositories/shared');

const REPOSITORIES = {
  users: require('../../src/repositories/users').createUserRepository,
  votes: require('../../src/repositories/votes').createVoteRepository,
  posts: require('../../src/repositories/posts').createPostRepository,
  favorites: require('../../src/repositories/favorites').createFavoriteRepository,
  messages: require('../../src/repositories/messages').createMessageRepository,
  account: require('../../src/repositories/account').createAccountRepository,
  'user-admin': require('../../src/repositories/user-admin').createUserAdminRepository,
  'site-admin': require('../../src/repositories/site-admin').createSiteAdminRepository,
  recalc: require('../../src/repositories/recalc').createRecalcRepository,
  uploads: require('../../src/repositories/uploads').createUploadRepository,
  ai: require('../../src/repositories/ai').createAiRepository,
};

const OPTION_VALUES = { points_base: '100', points_multiple: '1', points_post_q: '2', points_post_a: '4', points_select_a: '3', points_a_selected: '30', points_vote_up_q: '1', points_vote_down_q: '1', points_vote_up_a: '1', points_vote_down_a: '1', points_per_q_voted_up: '1', points_per_q_voted_down: '1', points_q_voted_max_gain: '10', points_q_voted_max_loss: '3', points_per_a_voted_up: '2', points_per_a_voted_down: '2', points_a_voted_max_gain: '20', points_a_voted_max_loss: '5', hot_weight_q_age: '100', hot_weight_a_age: '100', hot_weight_answers: '100', hot_weight_votes: '100', hot_weight_views: '100', max_store_user_updates: '50', page_size_wall: '30', allow_user_walls: '1' };
const options = { get: name => OPTION_VALUES[name] ?? '', dbTime: 7200000, isStored: () => true, toJSON: () => '<options>' };
// A sample value for a parameter, from its name.
function sample(name) {
  const n = name.toLowerCase();
  if (n === 'options') return options;
  if (n === 'db' || n === 'connection') return undefined;
  if (/^(ids|postids|userids|wordids|questionids|categoryids|names|columns|words|tags|levels|keys|directories|blobids|entries|rows)$/.test(n)) return n === 'columns' ? ['qposts', 'aupvotes'] : n === 'levels' ? [{ entitytype: 'C', entityid: 3, level: 50 }] : n.endsWith('ids') ? [10, 11] : ['sql', 'mysql'];
  if (/(^|_)(content|title|name|handle|email|slug|code|text|format|tag|word|value|key|box|type|entitytype|action|table|column|hash|token|field|flag|tagstring|notify|note|details|url|heading|tags|place|position|template|templates|emailcode|query|sql|countquery|model|feedback|question|answer|endpoint)$/.test(n)) {
    return { ip: '1.2.3.4', type: 'Q', entitytype: 'Q', action: 'V', box: 'inbox', table: 'qa_titlewords', column: 'titlecount', field: 'qposts', hash: 'h'.repeat(64), format: '', flag: 4, position: 'F2', place: 'FH', countquery: 'SELECT COUNT(*) FROM qa_posts' }[n] ?? `${n}-value`;
  }
  if (n === 'ip') return '1.2.3.4';
  if (/^(on|lock|remember|silent|value_?bool|visible|show|enabled|updatecounts|isuser|wall)$/.test(n)) return true;
  if (n === 'data' || n === 'image' || n === 'buffer') return Buffer.from('bytes');
  if (n === 'increment' || n === 'difference' || n === 'delta') return 1;
  if (n === 'ttl' || n === 'seconds') return 86400;
  if (n === 'limit' || n === 'count') return 5;
  if (n === 'start' || n === 'first' || n === 'next' || n === 'offset') return 0;
  if (n === 'last') return 20;
  if (n === 'period') return 2000;
  if (n === 'edit' || n === 'edited' || n === 'record') return { updatetype: 'E', userid: 5, ip: '1.2.3.4' };
  return 7; // an ID
}
// The parameter names of a function, with destructured ones as objects of samples.
function argsFor(fn) {
  const source = fn.toString();
  const params = /^[^(]*\(([^)]*(?:\{[^}]*\}[^)]*)*)\)/.exec(source)?.[1] ?? '';
  const args = [];
  let depth = 0;
  let current = '';
  for (const ch of params) {
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { args.push(current); current = ''; } else current += ch;
  }
  if (current.trim()) args.push(current);
  return args.map(param => {
    const p = param.trim().replace(/=.*$/s, '').trim();
    if (p.startsWith('{')) return Object.fromEntries(p.slice(1, -1).split(',').map(s => s.trim().split(/[:=]/)[0].trim()).filter(Boolean).map(k => [k, sample(k)]));
    if (p.startsWith('...')) return undefined;
    return sample(p);
  });
}

// A connection that records every statement and answers selects with one row of plausible columns, then
// none (so loops end), and writes with an insert ID.
function recordingPool(selectLimit = 3) {
  const log = [];
  let selects = 0;
  const row = () => new Proxy({ value: '3', total: '3', now: 7200, count: '3', userid: '5', postid: '10', wordid: '20', word: 'sql', title: 'title', content: 'content', categoryid: '3', parentid: null, level: '0', flags: '0', points: '9', handle: 'bob', email: 'b@x.test', tags: 'tag', backpath: 'tag', type: 'Q', basetype: 'Q', netvotes: '1', upvotes: '1', downvotes: '0', acount: '1', amaxvote: '1', vote: '1', flag: '0', blobid: '123', cookieid: '456', pageid: '3', widgetid: '9', fieldid: '2', position: '1', entitytype: 'C', entityid: '3', newValue: '1', changed: 1, affectedRows: 1, pos: '4', acquired: 1, position_: '2' }, { get: (t, k) => (k in t ? t[k] : undefined) });
  const answer = (sql, params) => {
    log.push(params === undefined ? [sql] : [sql, params]);
    const text = typeof sql === 'string' ? sql : sql.sql;
    if (text.startsWith('SELECT GET_LOCK(SHA2(')) return [[{ locked: 1 }]];
    if (text.startsWith('SELECT evaluation_id AS evaluationId')) {
      return [[{ evaluationId: 77, score: 85, feedback: 'Good answer', suggestions: '["Add an example"]', modelName: 'test-model' }]];
    }
    if (/^\s*(SELECT|SHOW)/i.test(text)) { selects++; return [selects <= selectLimit ? [row()] : [], []]; }
    return [{ insertId: 77, affectedRows: 1, changedRows: 1 }, undefined];
  };
  const connection = {
    beginTransaction: async () => log.push(['BEGIN']), commit: async () => log.push(['COMMIT']), rollback: async () => log.push(['ROLLBACK']), release: () => {},
    execute: async (sql, params) => answer(sql, params), query: async (sql, params) => answer(sql, params),
  };
  return { log, pool: { getConnection: async () => connection, execute: connection.execute, query: connection.query } };
}

const cases = Object.entries(REPOSITORIES);
// Methods whose arguments cannot be told from their names.
const OVERRIDES = {
  userSet: [5, 'handle', 'bob'],
  countOf: ['SELECT COUNT(*) FROM qa_posts'],
  rows: ['SELECT postid FROM qa_posts WHERE postid>=?', [10]],
  execute: ['DELETE FROM qa_userpoints WHERE userid>?', [12]],
  orderedMove: ['qa_categories', 'categoryid', 3, 2, 'parentid<=>?', [1]],
  orderedDelete: ['qa_categories', 'categoryid', 3, 'parentid<=>?', [1]],
  find: ['handle', 'bob'],
  saveEvaluation: [{ userId: 7 }],
  withAnswerLock: [7, async () => 'evaluated'],
};

async function methodNames(create) {
  const { pool } = recordingPool();
  const repo = create(pool);
  if (typeof repo.transaction !== 'function') return { direct: true, names: Object.keys(repo).filter(k => typeof repo[k] === 'function') };
  let names = [];
  await repo.transaction(async q => { names = Object.keys(q).filter(k => typeof q[k] === 'function'); });
  return { direct: false, names };
}

describe.each(cases)('%s repository', (repoName, create) => {
  test('every method\'s statements', async () => {
    const { direct, names } = await methodNames(create);
    const results = {};
    for (const name of names.sort()) {
      const { pool, log } = recordingPool(name === 'categorySetParent' ? 10 : 3);
      const repo = create(pool);
      let outcome;
      try {
        if (direct) {
          outcome = await repo[name](...(OVERRIDES[name] ?? argsFor(repo[name])));
        } else {
          outcome = await repo.transaction(async q => q[name](...(OVERRIDES[name] ?? argsFor(q[name]))));
        }
      } catch (error) { outcome = { error: error.message }; }
      results[name] = { statements: log, result: outcome instanceof Map ? Object.fromEntries(outcome) : outcome };
    }
    expect(Object.keys(results).length).toBeGreaterThan(0);
    // New blob and cookie IDs are random 64-bit numbers, as in Q2A; each run's become one marker.
    const stable = JSON.parse(JSON.stringify(results, (key, value) => (typeof value === 'string' && /^\d{15,20}$/.test(value) ? '<random 64-bit id>' : typeof value === 'bigint' ? '<random 64-bit id>' : value instanceof Map ? Object.fromEntries(value) : value)));
    expect(stable).toMatchSnapshot();
  });
});

describe('the transaction wrapper', () => {
  function pool({ failCommit, errnos = [] } = {}) {
    const log = [];
    let attempts = 0;
    return {
      log,
      pool: {
        getConnection: async () => {
          attempts++;
          const n = attempts;
          return {
            beginTransaction: async () => log.push(`begin ${n}`), commit: async () => { if (failCommit) throw new Error('commit failed'); log.push(`commit ${n}`); },
            rollback: async () => log.push(`rollback ${n}`), release: () => log.push(`release ${n}`),
            errno: errnos[n - 1],
          };
        },
      },
    };
  }
  test('commits, releases, then runs the after-commit work; a failed after-commit task is logged, not returned', async () => {
    const { pool: p, log } = pool();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transaction = createTransactor(p, connection => ({ connection }));
      const result = await transaction(async q => {
        q.afterCommit.push(async () => log.push('after 1'));
        q.afterCommit.push(async () => { throw new Error('mail down'); });
        q.afterCommit.push(async () => log.push('after 3'));
        return 'done';
      });
      expect(result).toBe('done');
      expect(log).toEqual(['begin 1', 'commit 1', 'release 1', 'after 1', 'after 3']);
      expect(spy).toHaveBeenCalledWith('After-commit task failed:', 'mail down');
    } finally { spy.mockRestore(); }
  });
  test('a failure rolls back, releases once and throws; queued work never runs', async () => {
    const { pool: p, log } = pool();
    const transaction = createTransactor(p, () => ({}));
    await expect(transaction(async q => { q.afterCommit.push(async () => log.push('never')); throw new Error('bad'); })).rejects.toThrow('bad');
    expect(log).toEqual(['begin 1', 'rollback 1', 'release 1']);
  });
  test('a failed commit rolls back too', async () => {
    const { pool: p, log } = pool({ failCommit: true });
    await expect(createTransactor(p, () => ({}))(async () => 1)).rejects.toThrow('commit failed');
    expect(log).toEqual(['begin 1', 'rollback 1', 'release 1']);
  });
  test('deadlocks and lock timeouts are retried on a fresh connection, up to five attempts', async () => {
    const { pool: p, log } = pool();
    let calls = 0;
    const transaction = createTransactor(p, () => ({}));
    const result = await transaction(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('deadlock'), { errno: 1213 });
      if (calls === 2) throw Object.assign(new Error('timeout'), { errno: 1205 });
      return 'third time';
    });
    expect(result).toBe('third time');
    expect(log.filter(l => l.startsWith('begin'))).toEqual(['begin 1', 'begin 2', 'begin 3']);
    let always = 0;
    await expect(createTransactor(pool().pool, () => ({}))(async () => { always++; throw Object.assign(new Error('deadlock'), { errno: 1213 }); })).rejects.toThrow('deadlock');
    expect(always).toBe(5);
    let other = 0;
    await expect(createTransactor(pool().pool, () => ({}))(async () => { other++; throw Object.assign(new Error('dup'), { errno: 1062 }); })).rejects.toThrow('dup');
    expect(other).toBe(1);
  });
});
