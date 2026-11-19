// Mirrors qa_get_options()/qa_default_option() from qa-include/app/options.php.
// option-defaults.json is generated from Q2A's $fixed_defaults array, so values are identical.
const fixedDefaults = require('../data/option-defaults.json');

// The dynamic (switch) defaults from qa_default_option() that migrated features rely on.
function dynamicDefault(name, get) {
  const numericOr = (oldName, fallback) => {
    const old = get(oldName);
    return old !== '' && !Number.isNaN(Number(old)) ? old : fallback;
  };
  switch (name) {
    case 'points_vote_up_q': case 'points_vote_down_q': return numericOr('points_vote_on_q', 1);
    case 'points_vote_up_a': case 'points_vote_down_a': return numericOr('points_vote_on_a', 1);
    case 'points_per_q_voted_up': case 'points_per_q_voted_down': return numericOr('points_per_q_voted', 1);
    case 'points_per_a_voted_up': case 'points_per_a_voted_down': return numericOr('points_per_a_voted', 2);
    default: return '';
  }
}

async function loadOptions(db) {
  const [rows] = await db.query('SELECT title, content FROM qa_options');
  const [[{ now }]] = await db.query('SELECT UNIX_TIMESTAMP(NOW()) AS now');
  const stored = new Map(rows.map(row => [row.title, row.content]));
  function get(name) {
    if (stored.has(name) && stored.get(name) !== null) return stored.get(name);
    return Object.hasOwn(fixedDefaults, name) ? fixedDefaults[name] : dynamicDefault(name, get);
  }
  // isStored: whether the option has a row (qa_get_options() writes the default when it reads one that has none).
  return { get, isStored: name => stored.has(name) && stored.get(name) !== null, dbTime: Number(now) };
}
module.exports = { loadOptions };
