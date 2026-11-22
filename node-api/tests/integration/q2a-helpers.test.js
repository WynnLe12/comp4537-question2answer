// The PHP ports in src/q2a/ (php.js, points.js, options.js, paths.js, text.js) against Q2A's own PHP helpers:
// every case in php-helpers-outputs.json was run through the PHP original in the PHP container
// (tests/fixtures/php-helpers.php, scripts/php-fixtures.sh), and the Node port must give the same answer.
//
// Each test checks a whole table of cases and lists every case where Node differs.
const php = require('../fixtures/php-helpers-outputs.json');
const { phpNum, phpInt, phpBool } = require('../../src/q2a/php');
const { pointsCalculations, pointsUpdateStatement } = require('../../src/q2a/points');
const { loadOptions } = require('../../src/q2a/options');
const { path, qRequest, qPathAbsolute } = require('../../src/q2a/paths');
const text = require('../../src/q2a/text');

const optionsWith = values => ({ get: name => values[name] ?? '' });
// Same value: primitives by ===, so PHP's -0.0 equals 0 (JSON keeps the sign); arrays and objects by content.
const same = (a, b) => (typeof a === 'object' && a !== null ? JSON.stringify(a) === JSON.stringify(b) : a === b);
function mismatches(cases, run) {
  const wrong = [];
  for (const row of cases) {
    const expected = row.at(-1);
    let actual;
    try { actual = run(...row.slice(0, -1)); } catch (error) { actual = `threw ${error.message}`; }
    if (!same(actual, expected)) wrong.push({ inputs: row.slice(0, -1), php: expected, node: actual });
  }
  return wrong;
}

test('the PHP cases are all there', () => {
  for (const [name, rows] of Object.entries(php)) if (name !== 'note') expect(rows.length).toBeGreaterThan(1);
});

describe('php.js: option strings read as PHP reads them', () => {
  test('(float)', () => expect(mismatches(php.casts.map(([v, f]) => [v, f]), phpNum)).toEqual([]));
  test('(int)', () => expect(mismatches(php.casts.map(([v, , i]) => [v, i]), phpInt)).toEqual([]));
  test('(bool)', () => expect(mismatches(php.casts.map(([v, , , b]) => [v, b]), phpBool)).toEqual([]));
  test('numbers and missing values', () => {
    expect([phpNum(3.5), phpNum(Infinity), phpNum(NaN), phpNum(null), phpNum(undefined)]).toEqual([3.5, 0, 0, 0, 0]);
    expect([phpInt(-2.7), phpInt('8.9')]).toEqual([-2, 8]);
    expect([phpBool(undefined), phpBool(null), phpBool(false), phpBool(0), phpBool(2), phpBool(true)]).toEqual([false, false, false, false, true, true]);
  });
});

describe('points.js', () => {
  test('qa_db_points_calculations(): every multiple and formula', () => {
    const wrong = [];
    for (const [set, expected] of php.pointsCalculations) {
      const actual = pointsCalculations(optionsWith(set));
      expect(Object.keys(actual)).toEqual(Object.keys(expected));
      // PHP keeps some multiples as the option string ("2.5"); both sides cast them with (int) before use.
      for (const [field, { multiple, formula }] of Object.entries(expected)) {
        const node = actual[field];
        if (node.multiple !== Number(multiple) || node.formula !== formula.replace(/\^/g, 'qa_')) wrong.push({ set, field, php: { multiple, formula }, node });
      }
    }
    expect(wrong).toEqual([]);
  });
  test('qa_db_points_update_ifuser(): the same statement, with the user ID in every place PHP puts it', () => {
    expect(mismatches(php.pointsUpdate, (set, userid, columns) => {
      const statement = pointsUpdateStatement(userid, columns, optionsWith(set));
      if (!statement) return null;
      let i = 0;
      return statement.sql.replace(/\?/g, () => `'${statement.params[i++]}'`) + (i === statement.params.length ? '' : ' [unused params]');
    })).toEqual([]);
  });
  test('no user means no statement', () => {
    expect(pointsUpdateStatement(undefined, true, optionsWith({}))).toBeNull();
  });
});

describe('options.js', () => {
  // loadOptions() over a fake qa_options table holding the old option values.
  const load = stored => loadOptions({
    query: async sql => (sql.includes('UNIX_TIMESTAMP') ? [[{ now: 1234 }]] : [Object.entries(stored).filter(([, v]) => v !== null).map(([title, content]) => ({ title, content }))]),
  });
  test('qa_default_option() for the vote points that fall back to an older option', async () => {
    const wrong = [];
    for (const [name, old, expected] of php.defaultOption) {
      const options = await load({ points_vote_on_q: old, points_vote_on_a: old, points_per_q_voted: old, points_per_a_voted: old });
      if (String(options.get(name)) !== String(expected)) wrong.push({ name, old, php: expected, node: options.get(name) });
    }
    expect(wrong).toEqual([]);
  });
  test('qa_default_option() for the mailing defaults built from other options', async () => {
    const options = await load({ site_title: 'My Site', site_url: 'http://example.test/qa/', from_email: 'from@example.test' });
    expect(mismatches(php.defaultOptionSite, name => options.get(name))).toEqual([]);
  });
  test('stored values win, a stored NULL counts as missing, and the database time is kept', async () => {
    const options = await load({ points_vote_on_q: '7', site_title: 'T', from_email: null });
    expect(options.get('points_vote_up_q')).toBe('7');
    expect(options.get('mailing_from_name')).toBe('T');
    expect(options.isStored('site_title')).toBe(true);
    expect(options.isStored('from_email')).toBe(false);
    expect(options.isStored('nothing')).toBe(false);
    expect(options.dbTime).toBe(1234);
  });
  // PHP builds from_email from the browser's host; Node has no browser request, so it uses site_url's host.
  test.each([
    ['http://www.example.test/qa/', 'no-reply@example.test'],
    ['https://qa.example.co.uk/', 'no-reply@example.co.uk'],
    ['http://questions.example.test/', 'no-reply@questions.example.test'],
    ['http://123.example.test/', 'no-reply@123.example.test'],
    ['http://localhost:8080/', 'no-reply@example.com'],
    ['http://example.test/', 'no-reply@example.test'],
    ['not a url', 'no-reply@example.com'],
  ])('from_email defaults from the site URL %s', async (siteUrl, expected) => {
    expect((await load({ site_url: siteUrl })).get('from_email')).toBe(expected);
  });
});

describe('paths.js', () => {
  test('qa_path() for every URL format', () => {
    expect(mismatches(php.path, (request, params, rooturl, neat, anchor) => path(request, params, rooturl, neat, anchor))).toEqual([]);
  });
  const siteOptions = ([words, accents, length]) =>
    optionsWith({ site_url: 'http://example.test/', neat_urls: '1', block_bad_words: words, q_urls_remove_accents: accents, q_urls_title_length: length });
  test('qa_q_request()', () => {
    expect(mismatches(php.qRequest, (opts, id, title) => qRequest(siteOptions(opts), id, title))).toEqual([]);
  });
  test('qa_q_path() with an absolute URL', () => {
    expect(mismatches(php.qPath, (opts, id, title, showtype, showid) => qPathAbsolute(siteOptions(opts), id, title, showtype, showid))).toEqual([]);
  });
});

describe('text.js', () => {
  test('qa_post_text()', () => expect(mismatches(php.postText, text.postText)).toEqual([]));
  test('qa_post_text() with nothing posted', () => {
    expect(text.postText(undefined)).toBeNull();
    expect(text.postText(null)).toBeNull();
  });
  test('qa_remove_utf8mb4()', () => expect(mismatches(php.removeUtf8mb4, text.removeUtf8mb4)).toEqual([]));
  test('qa_strlen()', () => expect(mismatches(php.strlen, text.strlen)).toEqual([]));
  test('qa_string_to_words() with every option', () => {
    expect(mismatches(php.stringToWords, (input, tolowercase, splitideographs, splithyphens) =>
      text.stringToWords(input, { tolowercase, splitideographs, splithyphens }))).toEqual([]);
  });
  test('qa_get_tags_field_value()', () => {
    expect(mismatches(php.tagsFromInput, (input, comma) => text.tagsFromInput(input, comma === '1'))).toEqual([]);
  });
  test('qa_block_words_explode()', () => expect(mismatches(php.blockWordsExplode, text.blockWordsExplode)).toEqual([]));
  test('qa_block_words_match_all(): whether anything matches', () => {
    expect(mismatches(php.blockWords.map(([s, w, match]) => [s, w, match]), text.blockWordsMatch)).toEqual([]);
  });
  test('qa_block_words_replace()', () => {
    expect(mismatches(php.blockWords.map(([s, w, , replaced]) => [s, w, replaced]), text.blockWordsReplace)).toEqual([]);
  });
  test('qa_block_ips_explode()', () => expect(mismatches(php.blockIpsExplode, text.blockIpsExplode)).toEqual([]));
  test('qa_slugify()', () => expect(mismatches(php.slugify, text.slugify)).toEqual([]));
  test('qa_tagstring_to_tags() and qa_tags_to_tagstring()', () => {
    expect(mismatches(php.tagstring.map(([s, tags]) => [s, tags]), text.tagstringToTags)).toEqual([]);
    expect(mismatches(php.tagstring.map(([s, tags, back]) => [tags, back]), text.tagsToTagstring)).toEqual([]);
  });
  test('qa_email_validate()', () => expect(mismatches(php.emailValidate, text.emailValidate)).toEqual([]));
  test('qa_combine_notify_email()', () => expect(mismatches(php.combineNotifyEmail, text.combineNotifyEmail)).toEqual([]));
  test('qa_random_alphanum(): base-36 characters, exactly as many as asked', () => {
    for (const length of [1, 3, 4, 12, 32]) {
      const value = text.randomAlphanum(length);
      expect(value).toMatch(new RegExp(`^[0-9a-z]{${length}}$`));
    }
    expect(new Set(Array.from({ length: 20 }, () => text.randomAlphanum(12))).size).toBe(20);
  });
  test('qa_viewer_text() for plain text and unknown formats', () => {
    expect(text.viewerText('  kept <b>as is</b> ', '')).toBe('  kept <b>as is</b> ');
    expect(text.viewerText('x', 'markdown')).toBe('[no viewer found for format: markdown]');
  });
});
