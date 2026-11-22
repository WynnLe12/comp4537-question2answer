// Numeric conversions that match how PHP treats option strings read from qa_options.
function phpNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}
const phpInt = value => Math.trunc(phpNum(value));
// PHP truthiness for option values ('' , '0' and 0 are false).
const phpBool = value => !(value === undefined || value === null || value === '' || value === '0' || value === 0 || value === false);
// PHP's empty() for the scalars Node passes: as !phpBool, so '0' is empty too.
const phpEmpty = value => !phpBool(value);
// PHP 8's is_numeric(): optional surrounding whitespace (PHP's own set), a sign, decimals and an exponent.
const phpIsNumeric = value => (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(value));
// PHP's (string) for scalars: true is '1', false and null are ''.
const phpString = value => (value === true ? '1' : value === false || value === null || value === undefined ? '' : String(value));
module.exports = { phpNum, phpInt, phpBool, phpEmpty, phpIsNumeric, phpString };
