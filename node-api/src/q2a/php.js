// Numeric conversions that match how PHP treats option strings read from qa_options.
function phpNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}
const phpInt = value => Math.trunc(phpNum(value));
// PHP truthiness for option values ('' , '0' and 0 are false).
const phpBool = value => !(value === undefined || value === null || value === '' || value === '0' || value === 0 || value === false);
module.exports = { phpNum, phpInt, phpBool };
