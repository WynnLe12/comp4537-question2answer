// Mirrors qa_get_options()/qa_default_option() from qa-include/app/options.php.
// option-defaults.json is generated from Q2A's $fixed_defaults array, so values are identical.
const fixedDefaults = require('../data/option-defaults.json');
const { phpIsNumeric } = require('./php');

// The dynamic (switch) defaults from qa_default_option() that migrated features rely on.
function dynamicDefault(name, get) {
  const numericOr = (oldName, fallback) => {
    const old = get(oldName);
    return phpIsNumeric(old) ? old : fallback; // is_numeric($oldvalue)
  };
  switch (name) {
    case 'points_vote_up_q': case 'points_vote_down_q': return numericOr('points_vote_on_q', 1);
    case 'points_vote_up_a': case 'points_vote_down_a': return numericOr('points_vote_on_a', 1);
    case 'points_per_q_voted_up': case 'points_per_q_voted_down': return numericOr('points_per_q_voted', 1);
    case 'points_per_a_voted_up': case 'points_per_a_voted_down': return numericOr('points_per_a_voted', 2);
    // qa_default_option()'s email defaults. PHP builds from_email from the host of the request that first
    // reads it; Node sees no browser request, so it uses the host in site_url (the same host on a live site).
    case 'from_email': {
      let host = '';
      try { host = new URL(get('site_url')).host; } catch { host = ''; }
      const parts = host.split('.');
      if (parts.length > 2 && parts[0].length < 5 && !phpIsNumeric(parts[0])) parts.shift(); // e.g. www. or qa. (is_numeric())
      return `no-reply@${parts.length > 1 ? parts.join('.') : 'example.com'}`;
    }
    case 'mailing_from_email': return get('from_email');
    case 'mailing_from_name': return get('site_title');
    case 'mailing_subject': return `A message from ${get('site_title')}`; // options/default_subject
    case 'mailing_body': return `\n\n\n--\n${get('site_title')}\n${get('site_url')}`;
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
