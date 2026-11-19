// Read argument fuzzing: every builder and read helper call from the read parity suite runs again with one
// argument swapped for a hostile value of the same kind (quotes, backslashes, LIKE wildcards, SQL fragments,
// emoji, NUL, padded or malformed numbers, 64-bit IDs, empty lists...). PHP's own code (the read harness) and
// Node must agree on every byte, or both refuse. This checks that Node writes arguments into SQL exactly as
// qa_db_apply_sub() does, beyond the arguments real pages happen to pass.
//
//   FUZZ_SEED=7 FUZZ_READS=400 scripts/reliability.sh read-fuzz
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { createPool } = require('../../src/db');
const { UI_URL, API_URL } = require('../parity/post-helpers');
const { KEY, normalise, canonResult, CASES, HELPER_CASES, buildFixtures } = require('../parity/read-cases');

const run = process.env.RELIABILITY === '1' ? describe : describe.skip;
jest.setTimeout(30 * 60 * 1000);
const SEED = Number(process.env.FUZZ_SEED || Math.floor(Math.random() * 2 ** 31));
const READS = Number(process.env.FUZZ_READS || 300);

const HOSTILE = {
  number: ['0', '-1', '007', ' 5', '5 ', '5abc', '1e3', '1.5', '-0', '+3', '18446744073709551615', '9223372036854775808', '99999999999999999999', '0x1F', '', '٣'],
  string: ["'", '"', '\\', "\\'", '%', '_', '%_%', "' OR '1'='1", "x' UNION SELECT 1 -- ", ';DROP TABLE qa_users;', '😀', 'ü', 'ÜBER', '数据', 'a\u0000b', ' padded ', 'tab\tnew\nline', '`', '$', '#', '^users', 'x'.repeat(300), ''],
  boolean: [true, false, 0, 1, '1', '0', '', null],
};
const kindOf = value => (typeof value === 'boolean' ? 'boolean' : value === null || value === undefined ? null
  : (typeof value === 'number' || /^-?\d+$/.test(String(value))) ? 'number' : typeof value === 'string' ? 'string' : null);

function random(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { int: n => Math.floor(next() * n), pick: list => list[Math.floor(next() * list.length)] };
}

// One argument of the call swapped for a hostile value of its kind (inside lists, one element).
function mutate(rng, args) {
  const slots = [];
  args.forEach((arg, i) => {
    if (Array.isArray(arg)) arg.forEach((item, j) => { if (kindOf(item)) slots.push([i, j, kindOf(item)]); });
    else if (kindOf(arg)) slots.push([i, null, kindOf(arg)]);
  });
  if (!slots.length) return null;
  const [i, j, kind] = rng.pick(slots);
  const value = rng.pick(HOSTILE[kind]);
  const out = args.map(arg => (Array.isArray(arg) ? [...arg] : arg));
  if (j === null) out[i] = value; else out[i][j] = value;
  return { args: out, slot: j === null ? `arg ${i}` : `arg ${i}[${j}]`, value };
}

// One read on one side: its result, or how it failed (PHP stops with a page, Node answers an error).
async function readOne(url, read) {
  const res = await request(url).post('').set('X-Q2A-Bridge-Key', KEY).send({ reads: [read] });
  if (res.status === 200 && Array.isArray(res.body?.results)) return { ok: true, result: res.body.results[0] };
  return { ok: false, status: res.status };
}

run('Read argument fuzzing: PHP read harness ↔ Node internal reads', () => {
  const suffix = randomBytes(3).toString('hex');
  const undo = [];
  let pool, fixtures;
  beforeAll(async () => { pool = createPool(); fixtures = await buildFixtures(pool, suffix, undo); });
  afterAll(async () => { for (const step of undo.reverse()) await step(); await pool.end(); });

  test(`${READS} hostile reads agree byte for byte (seed ${SEED})`, async () => {
    const rng = random(SEED);
    const calls = [
      ...CASES.map(([label, name, args, count]) => ({ label, name, args: args(fixtures), count: Boolean(count), helper: false })),
      ...HELPER_CASES.map(([label, name, args]) => ({ label, name, args: args(fixtures), count: false, helper: true })),
    ];
    const mismatches = [];
    let compared = 0;
    let bothRefused = 0;
    for (let n = 0; n < READS; n++) {
      const call = rng.pick(calls);
      const mutation = mutate(rng, call.args);
      if (!mutation) continue;
      const read = { name: call.name, args: mutation.args, count: call.count };
      const [php, node] = await Promise.all([readOne(`${UI_URL}/docker/php/read-harness.php`, read), readOne(`${API_URL}/api/v1/internal/reads`, read)]);
      const what = `${call.label}: ${mutation.slot} = ${JSON.stringify(mutation.value)}`;
      if (!php.ok || !node.ok) {
        if (php.ok !== node.ok) mismatches.push({ what, php: php.ok ? 'result' : `refused (${php.status})`, node: node.ok ? 'result' : `refused (${node.status})` });
        else bothRefused++;
        continue;
      }
      const compare = call.helper ? canonResult : normalise;
      if (JSON.stringify(compare(node.result)) !== JSON.stringify(compare(php.result))) mismatches.push({ what, php: JSON.stringify(compare(php.result)).slice(0, 300), node: JSON.stringify(compare(node.result)).slice(0, 300) });
      compared++;
    }
    console.log(`Read fuzzing: seed ${SEED}, ${compared} compared, ${bothRefused} refused by both, ${mismatches.length} different.`);
    if (mismatches.length) throw new Error(`${mismatches.length} reads differ (seed ${SEED}):\n${JSON.stringify(mismatches.slice(0, 8), null, 1)}`);
    expect(compared).toBeGreaterThan(READS / 2);
  });
});
