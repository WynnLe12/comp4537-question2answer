// The page reads the PHP bridge asks Node for (routes/v1/internal.js, reads/selects.js, reads/execute.js,
// reads/helpers.js), through the internal route with a recording database: every read parity case (each
// db/selects.php builder and db/*.php helper the pages call, from tests/parity/read-cases.js) with fixed
// arguments. Each read's SQL and result is a Jest snapshot. The read parity suite runs these same reads
// against MySQL and compares the results with PHP's own code, and the read fuzzer does so with hostile
// arguments, so the snapshots record SQL that matches PHP's; update them (npx jest -u) only for a change
// those suites accept.
const request = require('supertest');
const { createApp } = require('../../src/app');
const { CASES, HELPER_CASES } = require('../parity/read-cases');
const { applySub, postSelect, sortBy, isNumeric } = require('../../src/reads/execute');
const { ipHex, slugsToBackpath, countSpec } = require('../../src/reads/selects');

// Values for every fixture the cases draw on.
const F = {
  voter: '5', handle: 'bob', favuser: '6', user: '7', q: '10', postids: ['10', '11', '12'], ip: '192.0.2.4', catslugs: ['tech', 'phones'],
  votepost: '11', parentcat: '1', metatitle: 'qa_q_extra', childcat: '2', words: ['sort', 'list'], tag: 'sql', wallto: '7', voteuser: '5',
  to: '6', from: '5', blobid: '18446744073709551615', tagwords: ['sql', 'mysql'], suffix: 'abc', pageslug: 'about', pageid: '3', loginid: 'ext-1',
  limituser: '5', limitaction: 'Q', levelsuser: '6', favq: '10', email: 'bob@example.test', dupof: '9', cookieid: '123456789012345678',
  closedq: '13', catbackpath: 'phones/tech', cacheid: '42', c: '15',
};
// Rows the database answers with: text columns, a binary one, and a repeated key.
const ROWS = [
  { postid: '10', userid: '5', handle: 'bob', title: 'B title', netvotes: '2', count: '3', word: 'sql', content: 'x', cookieid: 'ÿ\u0001' },
  { postid: '11', userid: '6', handle: 'amy', title: 'A title', netvotes: '10', count: '1', word: 'list', content: null, cookieid: 'ab' },
  { postid: '10', userid: '7', handle: 'cat', title: 'C title', netvotes: '2', count: '7', word: 'sort', content: 'z', cookieid: '' },
];
const FIELDS = [...Object.keys(ROWS[0]).map(name => ({ name, characterSet: name === 'cookieid' ? 63 : 33, columnType: name === 'cookieid' ? 252 : 253 }))];
function fakePool() {
  const queries = [];
  const connection = {
    query: async q => {
      const sql = typeof q === 'string' ? q : q.sql;
      queries.push(sql);
      const rows = ROWS.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v === null ? null : Buffer.from(v, 'latin1')])));
      return [rows, FIELDS];
    },
    release: () => {},
  };
  return { queries, pool: { getConnection: async () => connection, query: async (...args) => { queries.push(args); return [[]]; } } };
}
const KEY = 'test-bridge-key';
async function read(name, args, count) {
  const { pool, queries } = fakePool();
  const app = createApp({ readPool: pool, bridgeSecret: KEY });
  const res = await request(app).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', KEY).send({ reads: [{ name, args, count }] });
  return { status: res.status, sql: queries, result: res.body.results?.[0] ?? res.body };
}

describe.each(CASES.map(([label, name, args, count]) => [label, name, args, count]))('builder: %s (%s)', (label, name, args, count) => {
  test('SQL and result', async () => {
    const result = await read(name, args(F), count);
    expect(result.status).toBe(200);
    expect(result).toMatchSnapshot();
  });
});

describe.each(HELPER_CASES.map(([label, name, args]) => [label, name, args]))('helper: %s (%s)', (label, name, args) => {
  test('SQL and result', async () => {
    const result = await read(name, args(F));
    expect(result).toMatchSnapshot();
  });
});

describe('the internal route', () => {
  const { pool } = fakePool();
  const app = createApp({ readPool: pool, bridgeSecret: KEY });
  test('needs the bridge key', async () => {
    await request(app).post('/api/v1/internal/reads').send({ reads: [] }).expect(404);
    await request(app).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', 'wrong').send({ reads: [] }).expect(404);
    await request(app).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', KEY).send({ reads: [] }).expect(200);
  });
  test('refuses unknown reads, bad arguments and too many reads', async () => {
    const send = reads => request(app).post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', KEY).send({ reads });
    expect((await send([{ name: 'toString', args: [] }]).expect(400)).body).toEqual({ error: { code: 'invalid_input', fields: { name: 'toString' } } });
    await send([{ name: 'qa_db_options_selectspec', args: 'x' }]).expect(400);
    await send('x').expect(400);
    await send(Array.from({ length: 101 }, () => ({ name: 'qa_db_options_selectspec', args: [] }))).expect(400);
    await send(Array.from({ length: 100 }, () => ({ name: 'qa_db_options_selectspec', args: [] }))).expect(200);
  });
  test('a read that fails names itself', async () => {
    const res = await request(createApp({ readPool: { getConnection: async () => ({ query: async () => { throw new Error('boom'); }, release: () => {} }) }, bridgeSecret: KEY }))
      .post('/api/v1/internal/reads').set('X-Q2A-Bridge-Key', KEY).send({ reads: [{ name: 'qa_db_options_selectspec', args: [] }] });
    expect(res.status).toBe(503);
  });
  test('the image cache stores what the bridge sends', async () => {
    const recorded = fakePool();
    const cacheApp = createApp({ readPool: recorded.pool, bridgeSecret: KEY });
    await request(cacheApp).post('/api/v1/internal/cache').set('X-Q2A-Bridge-Key', KEY).send({ type: 'i_64', cacheid: '42', content: Buffer.from('img').toString('base64') }).expect(204);
    expect(recorded.queries).toMatchSnapshot();
    for (const body of [{ type: 5, cacheid: '1', content: '' }, { type: 'i', cacheid: 'x', content: '' }, { type: 'i', cacheid: '1', content: 5 }]) {
      await request(cacheApp).post('/api/v1/internal/cache').set('X-Q2A-Bridge-Key', KEY).send(body).expect(400);
    }
  });
});

describe('qa_db_apply_sub() and qa_db_argument_to_mysql()', () => {
  test.each([
    ['SELECT * FROM ^posts WHERE postid=#', [5], 'SELECT * FROM qa_posts WHERE postid=5'],
    ['WHERE a=$', [5], "WHERE a='5'"],
    ['WHERE a=# AND b=$', ['x', 'y'], "WHERE a='x' AND b='y'"],
    ['WHERE a=$ AND b=#', [1, 2], "WHERE a='1' AND b=2"],
    ['IN (#)', [[1, 'a', null]], "IN (1,'a',NULL)"],
    ['VALUES #', [[[1, 2], [3, 'x']]], "VALUES (1,2),(3,'x')"],
    ['a=# b=#', [true, false], "a='1' b=''"],
    ['a=#', [' 5 '], 'a=5'],
    ['a=#', ['18446744073709551615'], 'a=18446744073709551615'],
    ['a=#', ["O'Reilly"], "a='O\\'Reilly'"],
    ['a=#', [null], 'a=NULL'],
    ['a=#', [{ x: 1, y: 2 }], 'a=1,2'],
    ['^users ^userpoints', null, 'qa_users qa_userpoints'],
    ['no placeholders', [], 'no placeholders'],
  ])('%s with %j', (query, args, expected) => {
    expect(applySub(query, args).sql).toBe(expected);
  });
  test('too few placeholders', () => {
    expect(() => applySub('a=#', [1, 2])).toThrow('Insufficient parameters in query: a=#');
  });
  test('is_numeric()', () => {
    expect(['5', ' 5', '5 ', '-1.5e3', '.5', 5, 0].every(isNumeric)).toBe(true);
    expect(['', 'x', '0x1', '1 2', NaN, Infinity, null, true].some(isNumeric)).toBe(false);
  });
});

describe('qa_db_post_select()', () => {
  const rows = [[0, { id: '1', n: '10', s: 'b' }], [1, { id: '2', n: '9', s: 'a' }], [2, { id: '3', n: '10', s: 'c' }]];
  test('sorting ascending keeps the order of equal keys', () => {
    expect(postSelect(rows, { sortasc: 'n' }).entries.map(([, r]) => r.id)).toEqual(['2', '1', '3']);
  });
  test('sorting descending, with and without a second key', () => {
    expect(postSelect(rows, { sortdesc: 'n' }).entries.map(([, r]) => r.id)).toEqual(['1', '3', '2']);
    expect(postSelect(rows, { sortdesc: 'n', sortdesc_2: 's' }).entries.map(([, r]) => r.id)).toEqual(['3', '1', '2']);
  });
  test('arrayvalue, single, and an empty single', () => {
    expect(postSelect(rows, { arrayvalue: 's' }).entries).toEqual([[0, 'b'], [1, 'a'], [2, 'c']]);
    expect(postSelect(rows, { arrayvalue: 'missing' }).entries[0]).toEqual([0, null]);
    expect(postSelect(rows, { single: true })).toEqual({ single: true, value: rows[0][1] });
    expect(postSelect([], { single: true })).toEqual({ single: true, value: null });
  });
  test('qa_sort_by() compares numbers as numbers and text as text', () => {
    const entries = [[0, { k: '10' }], [1, { k: '9' }], [2, { k: 'b' }], [3, { k: 'a' }], [4, { k: null }]];
    expect(sortBy(entries, 'k').map(([i]) => i)).toMatchSnapshot();
  });
});

describe('selects helpers', () => {
  test('ipHex(): an address\'s bytes, or empty', () => {
    expect([ipHex('1.2.3.4'), ipHex('::1'), ipHex('2001:db8::1.2.3.4'), ipHex('nope'), ipHex(undefined)]).toEqual(['01020304', '00000000000000000000000000000001', '20010db8000000000000000001020304', '', '']);
    expect(() => ipHex('1.2\u00003.4')).toThrow('null bytes');
  });
  test('slugsToBackpath() and countSpec()', () => {
    expect(slugsToBackpath(['a', 'b', 'c'])).toBe('c/b/a');
    expect(countSpec({ columns: [[null, 'x']], source: '^posts', arguments: [1], arraykey: 'postid', sortasc: 'x' })).toMatchSnapshot();
  });
});
