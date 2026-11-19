// Runs a selectspec the way qa_db_single_select() and qa_db_post_select() do (qa-include/qa-db.php),
// returning PHP's result in a form the bridge can rebuild exactly: every value as the text MySQL sends
// (binary values as base64), rows in order with their keys, then PHP's sorting, arrayvalue and single.
const STRING_TYPES = new Set([15, 249, 250, 251, 252, 253, 254]); // VARCHAR, the BLOBs, VAR_STRING, STRING
const BINARY_CHARSET = 63;

// qa_db_apply_sub(): ^ becomes the table prefix, then each $ or # (whichever comes first) takes the next
// argument; $ is always quoted, # is quoted only when not numeric. Here they become ? parameters.
function applySub(query, args) {
  let sql = query.replace(/\^([A-Za-z_0-9]+)/g, 'qa_$1');
  if (!Array.isArray(args)) return { sql, params: [] };
  const params = [];
  let out = '';
  let offset = 0;
  for (const arg of args) {
    const stringpos = sql.indexOf('$', offset);
    const numberpos = sql.indexOf('#', offset);
    let position;
    let alwaysquote;
    if (stringpos < 0 || (numberpos >= 0 && numberpos < stringpos)) { alwaysquote = false; position = numberpos; } else { alwaysquote = true; position = stringpos; }
    if (position < 0) throw new Error(`Insufficient parameters in query: ${query}`);
    out += sql.slice(offset, position) + '?';
    params.push(toParam(arg, alwaysquote));
    offset = position + 1;
  }
  out += sql.slice(offset);
  return { sql: out, params };
}
const isNumeric = value => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(value));
// qa_db_argument_to_mysql()
function toParam(arg, alwaysquote) {
  if (Array.isArray(arg)) return arg.map(item => (Array.isArray(item) ? item.map(sub => toParam(sub, alwaysquote)) : toParam(item, alwaysquote)));
  if (arg === null || arg === undefined) return null;
  if (typeof arg === 'boolean') return arg ? (alwaysquote ? '1' : 1) : (alwaysquote ? '' : '');
  if (!alwaysquote && isNumeric(arg)) return Number(arg);
  return String(arg);
}

// PHP's sort comparison in qa_sort_by_fn()
function compare(av, bv) {
  if (isNumeric(av) && isNumeric(bv)) return Number(av) === Number(bv) ? 0 : (Number(av) < Number(bv) ? -1 : 1);
  const a = String(av ?? '').toLowerCase();
  const b = String(bv ?? '').toLowerCase();
  return a === b ? 0 : (a < b ? -1 : 1);
}
const looseEqual = (a, b) => (isNumeric(a) && isNumeric(b) ? Number(a) === Number(b) : String(a ?? '') === String(b ?? ''));
// qa_sort_by(): a stable sort by one key, then a second.
function sortBy(entries, by1, by2) {
  return entries.map((entry, index) => ({ entry, index })).sort((x, y) => {
    let key = by1;
    if (looseEqual(x.entry[1][key], y.entry[1][key])) {
      if (by2 === undefined || by2 === null) return x.index - y.index;
      key = by2;
    }
    return compare(x.entry[1][key], y.entry[1][key]) || x.index - y.index;
  }).map(({ entry }) => entry);
}

async function runSelect(db, spec) {
  const columns = spec.columns.map(([alias, expression]) => (alias === null ? expression : `${expression} AS \`${alias}\``)).join(', ');
  const query = `SELECT ${columns}${String(spec.source ?? '').length ? ` FROM ${spec.source}` : ''}`;
  const { sql, params } = applySub(query, spec.arguments ?? []);
  const [rows, fields] = await db.query({ sql, values: params, typeCast: field => field.buffer() });
  const binary = new Set(fields.filter(f => f.characterSet === BINARY_CHARSET && STRING_TYPES.has(f.columnType)).map(f => f.name));
  // Values as mysqli gives them: text, or the raw bytes for binary columns (sent as base64).
  let entries = rows.map((row, index) => {
    const out = {};
    for (const [name, value] of Object.entries(row)) {
      out[name] = value === null ? null : binary.has(name) ? { b64: value.toString('base64') } : value.toString('utf8');
    }
    return [spec.arraykey ? out[spec.arraykey] : index, out];
  });
  // With an arraykey, a repeated key keeps the first position and the last row (as PHP arrays do).
  if (spec.arraykey) {
    const byKey = new Map();
    for (const [key, row] of entries) byKey.set(String(typeof key === 'object' && key ? key.b64 : key), [key, row]);
    entries = [...byKey.values()];
  }
  return postSelect(entries, spec);
}

// qa_db_post_select()
function postSelect(entries, spec) {
  if (spec.sortasc !== undefined) {
    entries = entries.map(([key, row], index) => [key, { ...row, _order_: String(index) }]);
    entries = sortBy(entries, spec.sortasc, '_order_');
  } else if (spec.sortdesc !== undefined) {
    if (spec.sortdesc_2 !== undefined) entries = sortBy(entries, spec.sortdesc, spec.sortdesc_2);
    else {
      let index = entries.length;
      entries = entries.map(([key, row]) => [key, { ...row, _order_: String(index--) }]);
      entries = sortBy(entries, spec.sortdesc, '_order_');
    }
    entries = entries.reverse();
  }
  if (spec.arrayvalue !== undefined) entries = entries.map(([key, row]) => [key, row[spec.arrayvalue] ?? null]);
  if (spec.single) return { single: true, value: entries.length ? entries[0][1] : null };
  return { single: false, entries };
}

module.exports = { runSelect, applySub, postSelect, sortBy };
