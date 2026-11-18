// Port of qa_db_points_calculations() and qa_db_points_update_ifuser() (qa-include/db/points.php).
// The generated SQL is the same statement PHP builds, including its MySQL user variables.
const { phpNum, phpInt } = require('./php');

function pointsCalculations(options) {
  const o = name => phpNum(options.get(name));
  const m = o('points_multiple');
  const voted = (prefix, type) => `COALESCE(SUM(` +
    `LEAST(${phpInt(options.get(`points_per_${prefix}_voted_up`))}*upvotes,${phpInt(options.get(`points_${prefix}_voted_max_gain`))})` +
    `-` +
    `LEAST(${phpInt(options.get(`points_per_${prefix}_voted_down`))}*downvotes,${phpInt(options.get(`points_${prefix}_voted_max_loss`))})` +
    `), 0) AS ${prefix}voteds FROM qa_posts AS userid_src WHERE LEFT(type, 1)='${type}' AND userid~`;
  const votes = (name, type, sign) => `COUNT(*) AS ${name} FROM qa_uservotes AS userid_src JOIN qa_posts ON userid_src.postid=qa_posts.postid WHERE userid_src.userid~ AND LEFT(qa_posts.type, 1)='${type}' AND userid_src.vote${sign}0`;
  return {
    qposts: { multiple: m * o('points_post_q'), formula: "COUNT(*) AS qposts FROM qa_posts AS userid_src WHERE userid~ AND type='Q'" },
    aposts: { multiple: m * o('points_post_a'), formula: "COUNT(*) AS aposts FROM qa_posts AS userid_src WHERE userid~ AND type='A'" },
    cposts: { multiple: 0, formula: "COUNT(*) AS cposts FROM qa_posts AS userid_src WHERE userid~ AND type='C'" },
    aselects: { multiple: m * o('points_select_a'), formula: "COUNT(*) AS aselects FROM qa_posts AS userid_src WHERE userid~ AND type='Q' AND selchildid IS NOT NULL" },
    aselecteds: { multiple: m * o('points_a_selected'), formula: "COUNT(*) AS aselecteds FROM qa_posts AS userid_src JOIN qa_posts AS questions ON questions.selchildid=userid_src.postid WHERE userid_src.userid~ AND userid_src.type='A' AND NOT (questions.userid<=>userid_src.userid)" },
    qupvotes: { multiple: m * o('points_vote_up_q'), formula: votes('qupvotes', 'Q', '>') },
    qdownvotes: { multiple: m * o('points_vote_down_q'), formula: votes('qdownvotes', 'Q', '<') },
    aupvotes: { multiple: m * o('points_vote_up_a'), formula: votes('aupvotes', 'A', '>') },
    adownvotes: { multiple: m * o('points_vote_down_a'), formula: votes('adownvotes', 'A', '<') },
    cupvotes: { multiple: 0, formula: votes('cupvotes', 'C', '>') },
    cdownvotes: { multiple: 0, formula: votes('cdownvotes', 'C', '<') },
    qvoteds: { multiple: m, formula: voted('q', 'Q') },
    avoteds: { multiple: m, formula: voted('a', 'A') },
    cvoteds: { multiple: m, formula: voted('c', 'C') },
    upvoteds: { multiple: 0, formula: 'COALESCE(SUM(upvotes), 0) AS upvoteds FROM qa_posts AS userid_src WHERE userid~' },
    downvoteds: { multiple: 0, formula: 'COALESCE(SUM(downvotes), 0) AS downvoteds FROM qa_posts AS userid_src WHERE userid~' },
  };
}

// Returns { sql, params } for one user, or null when PHP would do nothing.
function pointsUpdateStatement(userid, columns, options) {
  if (userid === null || userid === undefined) return null;
  const calculations = pointsCalculations(options);
  const keys = new Set(columns === true ? Object.keys(calculations) : columns);
  let insertfields = 'userid, ';
  let insertvalues = '?, ';
  let insertpoints = String(phpInt(options.get('points_base')));
  let updates = '';
  let updatepoints = insertpoints;
  for (const [field, calculation] of Object.entries(calculations)) {
    const multiple = Math.trunc(calculation.multiple);
    if (keys.has(field)) {
      insertfields += `${field}, `;
      insertvalues += `@_${field}:=(SELECT ${calculation.formula}), `;
      updates += `${field}=@_${field}, `;
      insertpoints += `+(${multiple}*@_${field})`;
    }
    updatepoints += `+(${multiple}*${keys.has(field) ? '@_' : ''}${field})`;
  }
  const template = `INSERT INTO qa_userpoints (${insertfields}points) VALUES (${insertvalues}${insertpoints}) ` +
    `ON DUPLICATE KEY UPDATE ${updates}points=${updatepoints}+bonus`;
  // Every "~" is a constraint on the user, exactly as PHP substitutes it.
  const params = [userid];
  const sql = template.replace(/~/g, () => { params.push(userid); return '=?'; });
  return { sql, params };
}

module.exports = { pointsCalculations, pointsUpdateStatement };
