// Port of the query builders in qa-include/db/selects.php. Each builder returns a selectspec like PHP's:
// { columns: [[alias or null, expression], ...], source, arguments, arraykey, arrayvalue, single,
//   sortasc, sortdesc, sortdesc_2 }, using Q2A's ^ table prefix and $ (string) / # (number) placeholders.
// The SQL is kept exactly as PHP writes it, so the results are the same rows; execute.js runs them.
const net = require('node:net');

const QA_DB_RETRIEVE_QS_AS = 50;
const QA_DB_RETRIEVE_TAGS = 200;
const QA_DB_RETRIEVE_USERS = 200;
const QA_DB_RETRIEVE_MESSAGES = 20;
const QA_IGNORED_WORDS_FREQ = 10000;
const QA_CATEGORY_DEPTH = 4;
const ENTITY = { QUESTION: 'Q', USER: 'U', TAG: 'T', CATEGORY: 'C', NONE: '-' };
const QA_UPDATE_SELECTED = 'S';

const isset = value => value !== undefined && value !== null;
const truthy = value => Boolean(value) && value !== '0'; // PHP truthiness for the flags builders take
const capped = (count, maximum) => (isset(count) ? Math.min(Number(count), maximum) : maximum);
const col = (spec, alias, expression) => spec.columns.push([alias, expression]);
// bin2hex(@inet_pton($ip)): the address's bytes in hex, or '' when it is not an address.
function ipHex(ip) {
  const text = String(ip ?? '');
  const kind = net.isIP(text);
  if (kind === 4) return Buffer.from(text.split('.').map(Number)).toString('hex');
  if (kind !== 6) return '';
  let address = text;
  const v4 = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { // an embedded IPv4 address is the last two groups
    const b = v4[1].split('.').map(Number);
    address = address.slice(0, -v4[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const groups = h => (h ? h.split(':') : []);
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return all.map(g => g.padStart(4, '0')).join('').toLowerCase();
}

// qa_db_posts_basic_selectspec()
function postsBasic(voteuserid = null, full = false, user = true) {
  const spec = {
    columns: [
      [null, '^posts.postid'], [null, '^posts.categoryid'], [null, '^posts.type'], ['basetype', 'LEFT(^posts.type, 1)'],
      ['hidden', "INSTR(^posts.type, '_HIDDEN')>0"], ['queued', "INSTR(^posts.type, '_QUEUED')>0"],
      [null, '^posts.acount'], [null, '^posts.amaxvote'], [null, '^posts.selchildid'], [null, '^posts.closedbyid'], [null, '^posts.upvotes'],
      [null, '^posts.downvotes'], [null, '^posts.netvotes'], [null, '^posts.views'], [null, '^posts.hotness'], [null, '^posts.flagcount'],
      [null, '^posts.title'], [null, '^posts.tags'], ['created', 'UNIX_TIMESTAMP(^posts.created)'], [null, '^posts.name'],
      ['categoryname', '^categories.title'], ['categorybackpath', '^categories.backpath'],
      ['categoryids', "CONCAT_WS(',', ^posts.catidpath1, ^posts.catidpath2, ^posts.catidpath3, ^posts.categoryid)"],
    ],
    arraykey: 'postid',
    source: '^posts LEFT JOIN ^categories ON ^categories.categoryid=^posts.categoryid',
    arguments: [],
  };
  if (isset(voteuserid)) {
    col(spec, 'uservote', '^uservotes.vote');
    col(spec, 'userflag', '^uservotes.flag');
    col(spec, 'userfavoriteq', '^userfavorites.entityid<=>^posts.postid');
    spec.source += ' LEFT JOIN ^uservotes ON ^posts.postid=^uservotes.postid AND ^uservotes.userid=$';
    spec.source += ' LEFT JOIN ^userfavorites ON ^posts.postid=^userfavorites.entityid AND ^userfavorites.userid=$ AND ^userfavorites.entitytype=$';
    spec.arguments.push(voteuserid, voteuserid, ENTITY.QUESTION);
  }
  if (truthy(full)) {
    col(spec, 'content', '^posts.content');
    col(spec, 'notify', '^posts.notify');
    col(spec, 'updated', 'UNIX_TIMESTAMP(^posts.updated)');
    col(spec, 'updatetype', '^posts.updatetype');
    col(spec, null, '^posts.format');
    col(spec, null, '^posts.lastuserid');
    col(spec, 'lastip', '^posts.lastip');
    col(spec, null, '^posts.parentid');
    col(spec, 'lastviewip', '^posts.lastviewip');
  }
  if (truthy(user)) {
    col(spec, null, '^posts.userid');
    col(spec, null, '^posts.cookieid');
    col(spec, 'createip', '^posts.createip');
    col(spec, null, '^userpoints.points');
    col(spec, null, '^users.flags');
    col(spec, null, '^users.level');
    col(spec, 'email', '^users.email');
    col(spec, 'handle', '^users.handle');
    col(spec, 'avatarblobid', 'BINARY ^users.avatarblobid');
    col(spec, null, '^users.avatarwidth');
    col(spec, null, '^users.avatarheight');
    spec.source += ' LEFT JOIN ^users ON ^posts.userid=^users.userid';
    if (truthy(full)) {
      col(spec, 'lasthandle', 'lastusers.handle');
      spec.source += ' LEFT JOIN ^users AS lastusers ON ^posts.lastuserid=lastusers.userid';
    }
    spec.source += ' LEFT JOIN ^userpoints ON ^posts.userid=^userpoints.userid';
  }
  return spec;
}

// qa_db_add_selectspec_opost(): columns are replaced in place when the alias already exists, as with PHP arrays.
function setCol(spec, alias, expression) {
  const existing = spec.columns.find(([a]) => a === alias);
  if (existing) existing[1] = expression;
  else spec.columns.push([alias, expression]);
}
function addOpost(spec, poststable, fromupdated = false, full = false) {
  spec.arraykey = 'opostid';
  setCol(spec, 'obasetype', `LEFT(${poststable}.type, 1)`);
  setCol(spec, 'ohidden', `INSTR(${poststable}.type, '_HIDDEN')>0`);
  setCol(spec, 'opostid', `${poststable}.postid`);
  setCol(spec, 'ouserid', `${poststable}${fromupdated ? '.lastuserid' : '.userid'}`);
  setCol(spec, 'ocookieid', `${poststable}.cookieid`);
  setCol(spec, 'oname', `${poststable}.name`);
  setCol(spec, 'oip', `${poststable}${fromupdated ? '.lastip' : '.createip'}`);
  setCol(spec, 'otime', `UNIX_TIMESTAMP(${poststable}${fromupdated ? '.updated' : '.created'})`);
  setCol(spec, 'oflagcount', `${poststable}.flagcount`);
  if (fromupdated) setCol(spec, 'oupdatetype', `${poststable}.updatetype`);
  if (truthy(full)) {
    setCol(spec, 'ocontent', `${poststable}.content`);
    setCol(spec, 'oformat', `${poststable}.format`);
  }
  if (fromupdated || truthy(full)) setCol(spec, 'oupdated', `UNIX_TIMESTAMP(${poststable}.updated)`);
}
// qa_db_add_selectspec_ousers()
function addOusers(spec, userstable, pointstable) {
  setCol(spec, 'oflags', `${userstable}.flags`);
  setCol(spec, 'olevel', `${userstable}.level`);
  setCol(spec, 'oemail', `${userstable}.email`);
  setCol(spec, 'ohandle', `${userstable}.handle`);
  setCol(spec, 'oavatarblobid', `BINARY ${userstable}.avatarblobid`);
  setCol(spec, 'oavatarwidth', `${userstable}.avatarwidth`);
  setCol(spec, 'oavatarheight', `${userstable}.avatarheight`);
  setCol(spec, 'opoints', `${pointstable}.points`);
}
// qa_db_slugs_to_backpath()
const slugsToBackpath = slugs => (Array.isArray(slugs) ? slugs : [slugs]).slice().reverse().join('/');
// qa_db_categoryslugs_sql_args()
function categorySlugsSql(slugs, args) {
  const list = Array.isArray(slugs) ? slugs : (String(slugs ?? '').length ? [slugs] : []);
  const levels = list.length;
  if (levels > 0 && levels <= QA_CATEGORY_DEPTH) {
    args.push(slugsToBackpath(list));
    return `${levels === QA_CATEGORY_DEPTH ? 'categoryid' : `catidpath${levels}`}=(SELECT categoryid FROM ^categories WHERE backpath=$ LIMIT 1) AND `;
  }
  return '';
}
// PHP 8's loose == against a non-numeric string: a bool compares as a bool (so true == 'Q'), null as ''
// and a number as its string form.
const looseEqualsString = (value, text) => (typeof value === 'boolean' ? value === truthy(text)
  : value === null || value === undefined ? text === '' : String(value) === text);
// The builders keep $specialtype itself when it == the base type (true included, which matches no type).
const specialType = (specialtype, base) => (looseEqualsString(specialtype, base) || looseEqualsString(specialtype, `${base}_QUEUED`)
  ? specialtype : (truthy(specialtype) ? `${base}_HIDDEN` : base));

const builders = {
  qa_db_qs_selectspec(voteuserid, sort, start, categoryslugs = null, createip = null, specialtype = false, full = false, count = null) {
    const type = specialType(specialtype, 'Q');
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    let sortsql;
    if (['acount', 'flagcount', 'netvotes', 'views'].includes(sort)) sortsql = `ORDER BY ^posts.${sort} DESC, ^posts.created DESC`;
    else if (['created', 'hotness'].includes(sort)) sortsql = `ORDER BY ^posts.${sort} DESC`;
    else throw new Error('qa_db_qs_selectspec() called with illegal sort value');
    const spec = postsBasic(voteuserid, full);
    spec.source += ` JOIN (SELECT postid FROM ^posts WHERE ${categorySlugsSql(categoryslugs, spec.arguments)}${isset(createip) ? 'createip=UNHEX($) AND ' : ''}type=$ ${sortsql} LIMIT #,#) y ON ^posts.postid=y.postid`;
    if (isset(createip)) spec.arguments.push(ipHex(createip));
    spec.arguments.push(type, start, count);
    spec.sortdesc = sort;
    return spec;
  },
  qa_db_unanswered_qs_selectspec(voteuserid, by, start, categoryslugs = null, specialtype = false, full = false, count = null) {
    const type = specialType(specialtype, 'Q');
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const bysql = by === 'selchildid' ? 'selchildid IS NULL' : by === 'amaxvote' ? 'amaxvote=0' : 'acount=0';
    const spec = postsBasic(voteuserid, full);
    spec.source += ` JOIN (SELECT postid FROM ^posts WHERE ${categorySlugsSql(categoryslugs, spec.arguments)}type=$ AND ${bysql} AND closedbyid IS NULL ORDER BY ^posts.created DESC LIMIT #,#) y ON ^posts.postid=y.postid`;
    spec.arguments.push(type, start, count);
    spec.sortdesc = 'created';
    return spec;
  },
  qa_db_recent_a_qs_selectspec(voteuserid, start, categoryslugs = null, createip = null, specialtype = false, fullanswers = false, count = null) {
    const type = specialType(specialtype, 'A');
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'aposts', false, fullanswers);
    addOusers(spec, 'ausers', 'auserpoints');
    spec.source += ' JOIN ^posts AS aposts ON ^posts.postid=aposts.parentid LEFT JOIN ^users AS ausers ON aposts.userid=ausers.userid' +
      ' LEFT JOIN ^userpoints AS auserpoints ON aposts.userid=auserpoints.userid JOIN (SELECT postid FROM ^posts WHERE ' +
      categorySlugsSql(categoryslugs, spec.arguments) + (isset(createip) ? 'createip=UNHEX($) AND ' : '') +
      `type=$ ORDER BY ^posts.created DESC LIMIT #,#) y ON aposts.postid=y.postid${truthy(specialtype) ? '' : " WHERE ^posts.type='Q'"}`;
    if (isset(createip)) spec.arguments.push(ipHex(createip));
    spec.arguments.push(type, start, count);
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_recent_c_qs_selectspec(voteuserid, start, categoryslugs = null, createip = null, specialtype = false, fullcomments = false, count = null) {
    const type = specialType(specialtype, 'C');
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'cposts', false, fullcomments);
    addOusers(spec, 'cusers', 'cuserpoints');
    spec.source += " JOIN ^posts AS parentposts ON ^posts.postid=(CASE LEFT(parentposts.type, 1) WHEN 'A' THEN parentposts.parentid ELSE parentposts.postid END)" +
      ' JOIN ^posts AS cposts ON parentposts.postid=cposts.parentid LEFT JOIN ^users AS cusers ON cposts.userid=cusers.userid' +
      ' LEFT JOIN ^userpoints AS cuserpoints ON cposts.userid=cuserpoints.userid JOIN (SELECT postid FROM ^posts WHERE ' +
      categorySlugsSql(categoryslugs, spec.arguments) + (isset(createip) ? 'createip=UNHEX($) AND ' : '') +
      `type=$ ORDER BY ^posts.created DESC LIMIT #,#) y ON cposts.postid=y.postid${truthy(specialtype) ? '' : " WHERE ^posts.type='Q' AND ((parentposts.type='Q') OR (parentposts.type='A'))"}`;
    if (isset(createip)) spec.arguments.push(ipHex(createip));
    spec.arguments.push(type, start, count);
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_recent_edit_qs_selectspec(voteuserid, start, categoryslugs = null, lastip = null, onlyvisible = true, fulledited = false, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'editposts', true, fulledited);
    addOusers(spec, 'editusers', 'edituserpoints');
    spec.source += " JOIN ^posts AS parentposts ON ^posts.postid=IF(LEFT(parentposts.type, 1)='Q', parentposts.postid, parentposts.parentid)" +
      " JOIN ^posts AS editposts ON parentposts.postid=IF(LEFT(editposts.type, 1)='Q', editposts.postid, editposts.parentid)" +
      ' LEFT JOIN ^users AS editusers ON editposts.lastuserid=editusers.userid LEFT JOIN ^userpoints AS edituserpoints ON editposts.lastuserid=edituserpoints.userid' +
      ' JOIN (SELECT postid FROM ^posts WHERE ' + categorySlugsSql(categoryslugs, spec.arguments) + (isset(lastip) ? 'lastip=UNHEX($) AND ' : '') +
      (truthy(onlyvisible) ? "type IN ('Q', 'A', 'C')" : '1') + ' ORDER BY ^posts.updated DESC LIMIT #,#) y ON editposts.postid=y.postid' +
      (truthy(onlyvisible) ? " WHERE parentposts.type IN ('Q', 'A', 'C') AND ^posts.type IN ('Q', 'A', 'C')" : '');
    if (isset(lastip)) spec.arguments.push(ipHex(lastip));
    spec.arguments.push(start, count);
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_flagged_post_qs_selectspec(voteuserid, start, fullflagged = false, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'flagposts', false, fullflagged);
    addOusers(spec, 'flagusers', 'flaguserpoints');
    spec.source += " JOIN ^posts AS parentposts ON ^posts.postid=IF(LEFT(parentposts.type, 1)='Q', parentposts.postid, parentposts.parentid)" +
      " JOIN ^posts AS flagposts ON parentposts.postid=IF(LEFT(flagposts.type, 1)='Q', flagposts.postid, flagposts.parentid)" +
      ' LEFT JOIN ^users AS flagusers ON flagposts.userid=flagusers.userid LEFT JOIN ^userpoints AS flaguserpoints ON flagposts.userid=flaguserpoints.userid' +
      " JOIN (SELECT postid FROM ^posts WHERE flagcount>0 AND type IN ('Q', 'A', 'C') ORDER BY ^posts.flagcount DESC, ^posts.created DESC LIMIT #,#) y ON flagposts.postid=y.postid";
    spec.arguments.push(start, count);
    spec.sortdesc = 'oflagcount';
    spec.sortdesc_2 = 'otime';
    return spec;
  },
  qa_db_posts_selectspec(voteuserid, postids, full = false) {
    const spec = postsBasic(voteuserid, full);
    spec.source += ' WHERE ^posts.postid IN (#)';
    spec.arguments.push(postids);
    return spec;
  },
  qa_db_posts_basetype_selectspec(postids) {
    return { columns: [[null, 'postid'], ['basetype', 'LEFT(type, 1)']], source: '^posts WHERE postid IN (#)', arguments: [postids], arraykey: 'postid', arrayvalue: 'basetype' };
  },
  qa_db_posts_to_qs_selectspec(voteuserid, postids, full = false) {
    const spec = postsBasic(voteuserid, full);
    setCol(spec, 'obasetype', 'LEFT(childposts.type, 1)');
    setCol(spec, 'opostid', 'childposts.postid');
    spec.source += " JOIN ^posts AS parentposts ON ^posts.postid=IF(LEFT(parentposts.type, 1)='Q', parentposts.postid, parentposts.parentid)" +
      " JOIN ^posts AS childposts ON parentposts.postid=IF(LEFT(childposts.type, 1)='Q', childposts.postid, childposts.parentid) WHERE childposts.postid IN (#)";
    spec.arraykey = 'opostid';
    spec.arguments.push(postids);
    return spec;
  },
  qa_db_full_post_selectspec(voteuserid, postid) {
    const spec = postsBasic(voteuserid, true);
    spec.source += ' WHERE ^posts.postid=#';
    spec.arguments.push(postid);
    spec.single = true;
    return spec;
  },
  qa_db_full_child_posts_selectspec(voteuserid, parentid) {
    const spec = postsBasic(voteuserid, true);
    spec.source += ' WHERE ^posts.parentid=#';
    spec.arguments.push(parentid);
    return spec;
  },
  qa_db_full_a_child_posts_selectspec(voteuserid, questionid) {
    const spec = postsBasic(voteuserid, true);
    spec.source += " JOIN ^posts AS parents ON ^posts.parentid=parents.postid WHERE parents.parentid=# AND LEFT(parents.type, 1)='A'";
    spec.arguments.push(questionid);
    return spec;
  },
  qa_db_post_parent_q_selectspec(postid) {
    const spec = postsBasic();
    spec.source += " WHERE ^posts.postid=(SELECT IF(LEFT(parent.type, 1)='A', parent.parentid, parent.postid) FROM ^posts AS child LEFT JOIN ^posts AS parent ON parent.postid=child.parentid WHERE child.postid=# AND parent.type IN('Q','A'))";
    spec.arguments = [postid];
    spec.single = true;
    return spec;
  },
  qa_db_post_close_post_selectspec(questionid) {
    const spec = postsBasic(null, true);
    spec.source += ' WHERE ^posts.postid=(SELECT closedbyid FROM ^posts WHERE postid=#)';
    spec.arguments = [questionid];
    spec.single = true;
    return spec;
  },
  qa_db_post_duplicates_selectspec(questionid) {
    const spec = postsBasic(null, true);
    spec.source += ' WHERE ^posts.closedbyid=#';
    spec.arguments = [questionid];
    return spec;
  },
  qa_db_post_meta_selectspec(postid, title) {
    const spec = { columns: [[null, 'title'], [null, 'content']], source: `^postmetas WHERE postid=# AND ${Array.isArray(title) ? 'title IN ($)' : 'title=$'}`, arguments: [postid, title], arrayvalue: 'content' };
    if (Array.isArray(title)) spec.arraykey = 'title';
    else spec.single = true;
    return spec;
  },
  qa_db_related_qs_selectspec(voteuserid, questionid, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    col(spec, null, 'score');
    spec.source += ' JOIN (SELECT postid, SUM(score)+LOG(postid)/1000000 AS score FROM ((SELECT ^titlewords.postid, LOG(#/titlecount) AS score FROM ^titlewords JOIN ^words ON ^titlewords.wordid=^words.wordid JOIN ^titlewords AS source ON ^titlewords.wordid=source.wordid WHERE source.postid=# AND titlecount<#) UNION ALL (SELECT ^posttags.postid, 2*LOG(#/tagcount) AS score FROM ^posttags JOIN ^words ON ^posttags.wordid=^words.wordid JOIN ^posttags AS source ON ^posttags.wordid=source.wordid WHERE source.postid=# AND tagcount<#) UNION ALL (SELECT ^posts.postid, LOG(#/^categories.qcount) FROM ^posts JOIN ^categories ON ^posts.categoryid=^categories.categoryid AND ^posts.type=\'Q\' WHERE ^categories.categoryid=(SELECT categoryid FROM ^posts WHERE postid=#) AND ^categories.qcount<#)) x WHERE postid!=# GROUP BY postid ORDER BY score DESC LIMIT #) y ON ^posts.postid=y.postid';
    spec.arguments.push(QA_IGNORED_WORDS_FREQ, questionid, QA_IGNORED_WORDS_FREQ, QA_IGNORED_WORDS_FREQ, questionid, QA_IGNORED_WORDS_FREQ, QA_IGNORED_WORDS_FREQ, questionid, QA_IGNORED_WORDS_FREQ, questionid, count);
    spec.sortdesc = 'score';
    return spec;
  },
  qa_db_search_posts_selectspec(voteuserid, titlewords, contentwords, tagwords, handlewords, handle, start, full = false, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid, full);
    col(spec, null, 'score');
    col(spec, null, 'matchparts');
    spec.source += " JOIN (SELECT questionid, SUM(score)+2*(LOG(#)*(MAX(^posts.hotness)-(SELECT MIN(hotness) FROM ^posts WHERE type='Q'))/((SELECT MAX(hotness) FROM ^posts WHERE type='Q')-(SELECT MIN(hotness) FROM ^posts WHERE type='Q')))+LOG(questionid)/1000000 AS score, GROUP_CONCAT(CONCAT_WS(':', matchposttype, matchpostid, ROUND(score,3))) AS matchparts FROM (";
    spec.sortdesc = 'score';
    spec.arguments.push(QA_IGNORED_WORDS_FREQ);
    let parts = 0;
    const nonEmpty = value => Array.isArray(value) ? value.length > 0 : truthy(value);
    if (nonEmpty(titlewords)) {
      spec.source += `${parts++ ? ' UNION ALL ' : ''}(SELECT postid AS questionid, LOG(#/titlecount) AS score, 'Q' AS matchposttype, postid AS matchpostid FROM ^titlewords JOIN ^words ON ^titlewords.wordid=^words.wordid WHERE word IN ($) AND titlecount<#)`;
      spec.arguments.push(QA_IGNORED_WORDS_FREQ, titlewords, QA_IGNORED_WORDS_FREQ);
    }
    if (nonEmpty(contentwords)) {
      spec.source += `${parts++ ? ' UNION ALL ' : ''}(SELECT questionid, (1-1/(1+count))*LOG(#/contentcount)*(CASE ^contentwords.type WHEN 'Q' THEN 1.0 WHEN 'A' THEN 0.5 ELSE 0.25 END) AS score, ^contentwords.type AS matchposttype, ^contentwords.postid AS matchpostid FROM ^contentwords JOIN ^words ON ^contentwords.wordid=^words.wordid WHERE word IN ($) AND contentcount<#)`;
      spec.arguments.push(QA_IGNORED_WORDS_FREQ, contentwords, QA_IGNORED_WORDS_FREQ);
    }
    if (nonEmpty(tagwords)) {
      spec.source += `${parts++ ? ' UNION ALL ' : ''}(SELECT postid AS questionid, 2*LOG(#/tagwordcount) AS score, 'Q' AS matchposttype, postid AS matchpostid FROM ^tagwords JOIN ^words ON ^tagwords.wordid=^words.wordid WHERE word IN ($) AND tagwordcount<#)`;
      spec.arguments.push(QA_IGNORED_WORDS_FREQ, tagwords, QA_IGNORED_WORDS_FREQ);
    }
    if (nonEmpty(handlewords)) {
      spec.source += `${parts++ ? ' UNION ALL ' : ''}(SELECT postid AS questionid, LOG(#/qposts) AS score, 'Q' AS matchposttype, postid AS matchpostid FROM ^posts JOIN ^users ON ^posts.userid=^users.userid JOIN ^userpoints ON ^userpoints.userid=^users.userid WHERE handle IN ($) AND type='Q')`;
      spec.arguments.push(QA_IGNORED_WORDS_FREQ, handlewords);
    }
    if (String(handle ?? '').length) {
      spec.source += `${parts++ ? ' UNION ALL ' : ''}(SELECT postid AS questionid, LOG(#/qposts) AS score, 'Q' AS matchposttype, postid AS matchpostid FROM ^posts JOIN ^users ON ^posts.userid=^users.userid JOIN ^userpoints ON ^userpoints.userid=^users.userid WHERE handle=$ AND type='Q')`;
      spec.arguments.push(QA_IGNORED_WORDS_FREQ, handle);
    }
    if (parts === 0) spec.source += '(SELECT NULL as questionid, 0 AS score, NULL AS matchposttype, NULL AS matchpostid FROM ^posts WHERE postid IS NULL)';
    spec.source += ') x LEFT JOIN ^posts ON ^posts.postid=questionid GROUP BY questionid ORDER BY score DESC LIMIT #,#) y ON ^posts.postid=y.questionid';
    spec.arguments.push(start, count);
    return spec;
  },
  qa_db_full_category_selectspec(slugsorid, isid) {
    let identifiersql = 'categoryid=#';
    if (!truthy(isid)) { identifiersql = 'backpath=$'; slugsorid = slugsToBackpath(slugsorid); }
    return { columns: ['categoryid', 'parentid', 'title', 'tags', 'qcount', 'content', 'backpath'].map(c => [null, c]), source: `^categories WHERE ${identifiersql}`, arguments: [slugsorid], single: true };
  },
  qa_db_category_nav_selectspec(slugsorid, isid, ispostid = false, full = false) {
    let identifiersql;
    if (truthy(isid)) identifiersql = truthy(ispostid) ? 'categoryid=(SELECT categoryid FROM ^posts WHERE postid=#)' : 'categoryid=#';
    else { identifiersql = 'backpath=$'; slugsorid = slugsToBackpath(slugsorid); }
    const parentselects = [
      'SELECT NULL AS parentkey',
      `SELECT grandparent.parentid FROM ^categories JOIN ^categories AS parent ON ^categories.parentid=parent.categoryid JOIN ^categories AS grandparent ON parent.parentid=grandparent.categoryid WHERE ^categories.${identifiersql}`,
      `SELECT parent.parentid FROM ^categories JOIN ^categories AS parent ON ^categories.parentid=parent.categoryid WHERE ^categories.${identifiersql}`,
      `SELECT parentid FROM ^categories WHERE ${identifiersql}`,
      `SELECT categoryid FROM ^categories WHERE ${identifiersql}`,
    ];
    let columns = [['parentid', '^categories.parentid'], ['title', '^categories.title'], ['tags', '^categories.tags'], ['qcount', '^categories.qcount'], ['position', '^categories.position']];
    if (truthy(full)) {
      columns = columns.map(([alias, expression]) => [alias, `MAX(${expression})`]);
      columns.push(['childcount', 'COUNT(child.categoryid)'], ['content', 'MAX(^categories.content)'], ['backpath', 'MAX(^categories.backpath)']);
    }
    columns.unshift([null, '^categories.categoryid']);
    return {
      columns,
      source: `^categories JOIN (${parentselects.join(' UNION ')}) y ON ^categories.parentid<=>parentkey${truthy(full) ? ' LEFT JOIN ^categories AS child ON child.parentid=^categories.categoryid GROUP BY ^categories.categoryid' : ''} ORDER BY ^categories.position`,
      arguments: [slugsorid, slugsorid, slugsorid, slugsorid],
      arraykey: 'categoryid',
      sortasc: 'position',
    };
  },
  qa_db_category_sub_selectspec(categoryid) {
    return { columns: ['categoryid', 'title', 'tags', 'qcount', 'position'].map(c => [null, c]), source: '^categories WHERE parentid<=># ORDER BY position', arguments: [categoryid], arraykey: 'categoryid', sortasc: 'position' };
  },
  qa_db_slugs_to_category_id_selectspec(slugs) {
    return { columns: [[null, 'categoryid']], source: '^categories WHERE backpath=$', arguments: [slugsToBackpath(slugs)], arrayvalue: 'categoryid', single: true };
  },
  qa_db_pages_selectspec(onlynavin = null, onlypageids = null) {
    const spec = { columns: [[null, 'pageid'], [null, 'title'], [null, 'flags'], ['permit', 'permit+0'], [null, 'nav'], [null, 'tags'], [null, 'position'], [null, 'heading']], arraykey: 'pageid', sortasc: 'position' };
    if (isset(onlypageids)) { spec.source = '^pages WHERE pageid IN (#)'; spec.arguments = [onlypageids]; }
    else if (isset(onlynavin)) { spec.source = '^pages WHERE nav IN ($) ORDER BY position'; spec.arguments = [onlynavin]; }
    else spec.source = '^pages ORDER BY position';
    return spec;
  },
  qa_db_widgets_selectspec() {
    return { columns: ['widgetid', 'place', 'position', 'tags', 'title'].map(c => [null, c]), source: '^widgets ORDER BY position', sortasc: 'position' };
  },
  qa_db_page_full_selectspec(slugorpageid, ispageid) {
    return { columns: ['pageid', 'title', 'flags', 'permit', 'nav', 'tags', 'position', 'heading', 'content'].map(c => [null, c]), source: `^pages WHERE ${truthy(ispageid) ? 'pageid' : 'tags'}=$`, arguments: [slugorpageid], single: true };
  },
  qa_db_tag_recent_qs_selectspec(voteuserid, tag, start, full = false, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid, full);
    spec.source += ' JOIN (SELECT postid FROM ^posttags WHERE wordid=(SELECT wordid FROM ^words WHERE word=$ AND word=$ COLLATE utf8_bin LIMIT 1) ORDER BY postcreated DESC LIMIT #,#) y ON ^posts.postid=y.postid';
    spec.arguments.push(tag, String(tag).toLowerCase(), start, count);
    spec.sortdesc = 'created';
    return spec;
  },
  qa_db_tag_word_selectspec(tag) {
    return { columns: [[null, 'wordid'], [null, 'word'], [null, 'tagcount']], source: '^words WHERE word=$ AND word=$ COLLATE utf8_bin', arguments: [tag, String(tag).toLowerCase()], single: true };
  },
  qa_db_user_recent_qs_selectspec(voteuserid, identifier, count = null, start = 0) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    spec.source += " WHERE ^posts.userid=(SELECT userid FROM ^users WHERE handle=$ LIMIT 1) AND type='Q' ORDER BY ^posts.created DESC LIMIT #,#";
    spec.arguments.push(identifier, start, count);
    spec.sortdesc = 'created';
    return spec;
  },
  qa_db_user_recent_a_qs_selectspec(voteuserid, identifier, count = null, start = 0) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'aposts');
    setCol(spec, 'oupvotes', 'aposts.upvotes');
    setCol(spec, 'odownvotes', 'aposts.downvotes');
    setCol(spec, 'onetvotes', 'aposts.netvotes');
    spec.source += " JOIN ^posts AS aposts ON ^posts.postid=aposts.parentid JOIN (SELECT postid FROM ^posts WHERE  userid=(SELECT userid FROM ^users WHERE handle=$ LIMIT 1) AND type='A' ORDER BY created DESC LIMIT #,#) y ON aposts.postid=y.postid WHERE ^posts.type='Q'";
    spec.arguments.push(identifier, start, count);
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_user_recent_c_qs_selectspec(voteuserid, identifier, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'cposts');
    spec.source += " JOIN ^posts AS parentposts ON ^posts.postid=(CASE parentposts.type WHEN 'A' THEN parentposts.parentid ELSE parentposts.postid END) JOIN ^posts AS cposts ON parentposts.postid=cposts.parentid" +
      " JOIN (SELECT postid FROM ^posts WHERE  userid=(SELECT userid FROM ^users WHERE handle=$ LIMIT 1) AND type='C' ORDER BY created DESC LIMIT #) y ON cposts.postid=y.postid WHERE ^posts.type='Q' AND parentposts.type IN ('Q', 'A')";
    spec.arguments.push(identifier, count);
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_user_recent_edit_qs_selectspec(voteuserid, identifier, count = null) {
    count = capped(count, QA_DB_RETRIEVE_QS_AS);
    const spec = postsBasic(voteuserid);
    addOpost(spec, 'editposts', true);
    spec.source += " JOIN ^posts AS parentposts ON ^posts.postid=IF(LEFT(parentposts.type, 1)='Q', parentposts.postid, parentposts.parentid)" +
      " JOIN ^posts AS editposts ON parentposts.postid=IF(LEFT(editposts.type, 1)='Q', editposts.postid, editposts.parentid)" +
      " JOIN (SELECT postid FROM ^posts WHERE  lastuserid=(SELECT userid FROM ^users WHERE handle=$ LIMIT 1) AND type IN ('Q', 'A', 'C') ORDER BY updated DESC LIMIT #) y ON editposts.postid=y.postid " +
      " WHERE parentposts.type IN ('Q', 'A', 'C') AND ^posts.type IN ('Q', 'A', 'C')";
    spec.arguments.push(identifier, count);
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_popular_tags_selectspec(start, count = null) {
    count = isset(count) ? count : QA_DB_RETRIEVE_TAGS;
    return { columns: [[null, 'word'], [null, 'tagcount']], source: '^words JOIN (SELECT wordid FROM ^words WHERE tagcount>0 ORDER BY tagcount DESC LIMIT #,#) y ON ^words.wordid=y.wordid', arguments: [start, count], arraykey: 'word', arrayvalue: 'tagcount', sortdesc: 'tagcount' };
  },
  qa_db_userfields_selectspec() {
    return { columns: ['fieldid', 'title', 'content', 'flags', 'permit', 'position'].map(c => [null, c]), source: '^userfields', arraykey: 'title', sortasc: 'position' };
  },
  qa_db_user_account_selectspec(useridhandle, isuserid) {
    return {
      columns: [[null, '^users.userid'], [null, 'passsalt'], ['passcheck', 'HEX(passcheck)'], [null, 'passhash'], [null, 'email'], [null, 'level'], [null, 'emailcode'], [null, 'handle'],
        ['created', 'UNIX_TIMESTAMP(created)'], [null, 'sessioncode'], [null, 'sessionsource'], [null, 'flags'], ['loggedin', 'UNIX_TIMESTAMP(loggedin)'],
        [null, 'loginip'], ['written', 'UNIX_TIMESTAMP(written)'], [null, 'writeip'], ['avatarblobid', 'BINARY avatarblobid'],
        [null, 'avatarwidth'], [null, 'avatarheight'], [null, 'points'], [null, 'wallposts']],
      source: `^users LEFT JOIN ^userpoints ON ^userpoints.userid=^users.userid WHERE ^users.${truthy(isuserid) ? 'userid' : 'handle'}=$`,
      arguments: [useridhandle],
      single: true,
    };
  },
  qa_db_user_profile_selectspec(useridhandle, isuserid) {
    return { columns: [[null, 'title'], [null, 'content']], source: `^userprofile WHERE userid=${truthy(isuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)'}`, arguments: [useridhandle], arraykey: 'title', arrayvalue: 'content' };
  },
  qa_db_user_notices_selectspec(userid) {
    return { columns: [[null, 'noticeid'], [null, 'content'], [null, 'format'], [null, 'tags'], ['created', 'UNIX_TIMESTAMP(created)']], source: '^usernotices WHERE userid=$ ORDER BY created', arguments: [userid], sortasc: 'created' };
  },
  qa_db_user_points_selectspec(identifier, isuserid = false) {
    return {
      columns: ['points', 'qposts', 'aposts', 'cposts', 'aselects', 'aselecteds', 'qupvotes', 'qdownvotes', 'aupvotes', 'adownvotes', 'qvoteds', 'avoteds', 'upvoteds', 'downvoteds', 'bonus'].map(c => [null, c]),
      source: `^userpoints WHERE userid=${truthy(isuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)'}`, arguments: [identifier], single: true,
    };
  },
  qa_db_user_rank_selectspec(identifier, isuserid = false) {
    return { columns: [['rank', '1+COUNT(*)']], source: `^userpoints WHERE points>COALESCE((SELECT points FROM ^userpoints WHERE userid=${truthy(isuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)'}), 0)`, arguments: [identifier], arrayvalue: 'rank', single: true };
  },
  qa_db_top_users_selectspec(start, count = null) {
    count = capped(count, QA_DB_RETRIEVE_USERS);
    return {
      columns: [[null, '^users.userid'], [null, 'handle'], [null, 'points'], [null, 'flags'], [null, '^users.email'], ['avatarblobid', 'BINARY avatarblobid'], [null, 'avatarwidth'], [null, 'avatarheight']],
      source: '^users JOIN (SELECT userid FROM ^userpoints ORDER BY points DESC LIMIT #,#) y ON ^users.userid=y.userid JOIN ^userpoints ON ^users.userid=^userpoints.userid',
      arguments: [start, count], arraykey: 'userid', sortdesc: 'points',
    };
  },
  qa_db_newest_users_selectspec(start, count = null) {
    count = capped(count, QA_DB_RETRIEVE_USERS);
    return {
      columns: [[null, 'userid'], [null, 'handle'], [null, 'flags'], [null, 'email'], ['created', 'UNIX_TIMESTAMP(created)'], ['avatarblobid', 'BINARY avatarblobid'], [null, 'avatarwidth'], [null, 'avatarheight']],
      source: '^users ORDER BY created DESC, userid DESC LIMIT #,#', arguments: [start, count], sortdesc: 'created', sortdesc_2: 'userid',
    };
  },
  qa_db_users_from_level_selectspec(level, start = 0, count = null) {
    count = capped(count, QA_DB_RETRIEVE_USERS);
    return { columns: [[null, '^users.userid'], [null, 'handle'], [null, 'level']], source: '^users WHERE level >= # ORDER BY level DESC, handle LIMIT #, #', arguments: [level, start, count], sortdesc: 'level' };
  },
  qa_db_users_from_level_count_selectspec(level) {
    return countSpec({ source: '^users WHERE level >= #', arguments: [level] });
  },
  qa_db_users_with_flag_selectspec(flag, start = 0, limit = null) {
    let source = '^users WHERE (flags & #)';
    const args = [flag];
    if (isset(limit)) { source += ' LIMIT #,#'; args.push(start, Math.min(Number(limit), QA_DB_RETRIEVE_USERS)); }
    return { columns: [[null, '^users.userid'], [null, 'handle'], [null, 'flags'], [null, 'level']], source, arguments: args };
  },
  qa_db_recent_messages_selectspec(fromidentifier, fromisuserid, toidentifier, toisuserid, count = null, start = 0) {
    count = capped(count, QA_DB_RETRIEVE_MESSAGES);
    let where;
    if (isset(fromidentifier)) where = `fromuserid=${truthy(fromisuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)'} AND type='PRIVATE'`;
    else where = "type='PUBLIC'";
    const tosub = truthy(toisuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)';
    return {
      columns: messageColumns(),
      source: `^messages LEFT JOIN ^users ufrom ON fromuserid=ufrom.userid LEFT JOIN ^users uto ON touserid=uto.userid WHERE ${where} AND touserid=${tosub} ORDER BY ^messages.created DESC LIMIT #,#`,
      arguments: isset(fromidentifier) ? [fromidentifier, toidentifier, start, count] : [toidentifier, start, count],
      arraykey: 'messageid', sortdesc: 'created',
    };
  },
  qa_db_messages_inbox_selectspec(type, toidentifier, toisuserid, start = 0, limit = null) {
    return messageBox('touserid', 'tohidden', type, toidentifier, toisuserid, start, limit);
  },
  qa_db_messages_outbox_selectspec(type, fromidentifier, fromisuserid, start = 0, limit = null) {
    return messageBox('fromuserid', 'fromhidden', type, fromidentifier, fromisuserid, start, limit);
  },
  qa_db_is_favorite_selectspec(userid, entitytype, identifier) {
    const spec = { columns: [['flags', 'COUNT(*)']], source: '^userfavorites WHERE userid=$ AND entitytype=$', arrayvalue: 'flags', single: true };
    if (entitytype === ENTITY.USER) spec.source += ' AND entityid=(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)';
    else if (entitytype === ENTITY.TAG) spec.source += ' AND entityid=(SELECT wordid FROM ^words WHERE word=$ LIMIT 1)';
    else if (entitytype === ENTITY.CATEGORY) { spec.source += ' AND entityid=(SELECT categoryid FROM ^categories WHERE backpath=$ LIMIT 1)'; identifier = slugsToBackpath(identifier); }
    else spec.source += ' AND entityid=$';
    spec.arguments = [userid, entitytype, identifier];
    return spec;
  },
  qa_db_user_favorite_qs_selectspec(userid, limit = null, start = 0) {
    const spec = postsBasic(userid);
    spec.source += ' JOIN ^userfavorites AS selectfave ON ^posts.postid=selectfave.entityid WHERE selectfave.userid=$ AND selectfave.entitytype=$ AND ^posts.type="Q" ORDER BY ^posts.created DESC';
    spec.arguments.push(userid, ENTITY.QUESTION);
    if (isset(limit)) { spec.source += ' LIMIT #,#'; spec.arguments.push(start, Math.min(Number(limit), QA_DB_RETRIEVE_QS_AS)); }
    spec.sortdesc = 'created';
    return spec;
  },
  qa_db_user_favorite_users_selectspec(userid, limit = null, start = 0) {
    let source = '^users JOIN ^userpoints ON ^users.userid=^userpoints.userid JOIN ^userfavorites ON ^users.userid=^userfavorites.entityid WHERE ^userfavorites.userid=$ AND ^userfavorites.entitytype=$ ORDER BY ^users.handle';
    const args = [userid, ENTITY.USER];
    if (isset(limit)) { source += ' LIMIT #,#'; args.push(start, Math.min(Number(limit), QA_DB_RETRIEVE_USERS)); }
    return { columns: [[null, '^users.userid'], [null, 'handle'], [null, 'points'], [null, 'flags'], [null, '^users.email'], ['avatarblobid', 'BINARY avatarblobid'], [null, 'avatarwidth'], [null, 'avatarheight']], source, arguments: args, sortasc: 'handle' };
  },
  qa_db_user_favorite_tags_selectspec(userid, limit = null, start = 0) {
    let source = '^words JOIN ^userfavorites ON ^words.wordid=^userfavorites.entityid WHERE ^userfavorites.userid=$ AND ^userfavorites.entitytype=$ ORDER BY ^words.tagcount DESC';
    const args = [userid, ENTITY.TAG];
    if (isset(limit)) { source += ' LIMIT #,#'; args.push(start, Math.min(Number(limit), QA_DB_RETRIEVE_TAGS)); }
    return { columns: [[null, 'word'], [null, 'tagcount']], source, arguments: args, sortdesc: 'tagcount' };
  },
  qa_db_user_favorite_categories_selectspec(userid) {
    return { columns: ['categoryid', 'title', 'tags', 'qcount', 'backpath', 'content'].map(c => [null, c]), source: '^categories JOIN ^userfavorites ON ^categories.categoryid=^userfavorites.entityid WHERE ^userfavorites.userid=$ AND ^userfavorites.entitytype=$', arguments: [userid, ENTITY.CATEGORY], sortasc: 'title' };
  },
  qa_db_user_favorite_non_qs_selectspec(userid) {
    return {
      columns: [['type', 'entitytype'], ['userid', 'IF (entitytype=$, entityid, NULL)'], ['categorybackpath', '^categories.backpath'], ['tags', '^words.word']],
      source: '^userfavorites LEFT JOIN ^words ON entitytype=$ AND wordid=entityid LEFT JOIN ^categories ON entitytype=$ AND categoryid=entityid WHERE userid=$ AND entitytype!=$',
      arguments: [ENTITY.USER, ENTITY.TAG, ENTITY.CATEGORY, userid, ENTITY.QUESTION],
    };
  },
  qa_db_user_updates_selectspec(userid, forfavorites = true, forcontent = true) {
    const spec = postsBasic(userid);
    const nonesql = `'${ENTITY.NONE}'`;
    setCol(spec, 'obasetype', 'LEFT(updateposts.type, 1)');
    setCol(spec, 'oupdatetype', 'fullevents.updatetype');
    setCol(spec, 'ohidden', "INSTR(updateposts.type, '_HIDDEN')>0");
    setCol(spec, 'opostid', 'fullevents.lastpostid');
    setCol(spec, 'ouserid', 'fullevents.lastuserid');
    setCol(spec, 'otime', 'UNIX_TIMESTAMP(fullevents.updated)');
    setCol(spec, 'opersonal', `fullevents.entitytype=${nonesql}`);
    setCol(spec, 'oparentid', 'updateposts.parentid');
    addOusers(spec, 'eventusers', 'eventuserpoints');
    if (truthy(forfavorites)) {
      spec.source += ` JOIN (SELECT entitytype, questionid, lastpostid, updatetype, lastuserid, updated FROM ^userevents WHERE userid=$${truthy(forcontent) ? '' : ` AND entitytype!=${nonesql}`}` +
        ' UNION SELECT ^sharedevents.entitytype, questionid, lastpostid, updatetype, lastuserid, updated FROM ^sharedevents JOIN ^userfavorites ON ^sharedevents.entitytype=^userfavorites.entitytype AND ^sharedevents.entityid=^userfavorites.entityid AND ^userfavorites.nouserevents=1 WHERE userid=$) fullevents ON ^posts.postid=fullevents.questionid';
      spec.arguments.push(userid, userid);
    } else {
      spec.source += ` JOIN ^userevents AS fullevents ON ^posts.postid=fullevents.questionid AND fullevents.userid=$ AND fullevents.entitytype=${nonesql}`;
      spec.arguments.push(userid);
    }
    spec.source += ` JOIN ^posts AS updateposts ON updateposts.postid=fullevents.lastpostid AND (updateposts.type IN ('Q', 'A', 'C') OR fullevents.entitytype=${nonesql})` +
      " AND (^posts.selchildid=fullevents.lastpostid OR NOT fullevents.updatetype<=>$) AND ^posts.type IN ('Q', 'Q_HIDDEN')" +
      ' LEFT JOIN ^users AS eventusers ON fullevents.lastuserid=eventusers.userid LEFT JOIN ^userpoints AS eventuserpoints ON fullevents.lastuserid=eventuserpoints.userid';
    spec.arguments.push(QA_UPDATE_SELECTED);
    delete spec.arraykey;
    spec.sortdesc = 'otime';
    return spec;
  },
  qa_db_user_limits_selectspec(userid) {
    return { columns: [[null, 'action'], [null, 'period'], [null, 'count']], source: '^userlimits WHERE userid=$', arguments: [userid], arraykey: 'action' };
  },
  qa_db_ip_limits_selectspec(ip) {
    return { columns: [[null, 'action'], [null, 'period'], [null, 'count']], source: '^iplimits WHERE ip=UNHEX($)', arguments: [ipHex(ip)], arraykey: 'action' };
  },
  qa_db_user_levels_selectspec(identifier, isuserid = false, full = false) {
    const spec = {
      columns: [[null, 'entityid'], [null, 'entitytype'], [null, 'level']],
      source: `^userlevels${truthy(full) ? ' LEFT JOIN ^categories ON ^userlevels.entitytype=$ AND ^userlevels.entityid=^categories.categoryid' : ''} WHERE userid=${truthy(isuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)'}`,
      arguments: [identifier],
    };
    if (truthy(full)) { spec.columns.push([null, 'title'], [null, 'backpath']); spec.arguments.unshift(ENTITY.CATEGORY); }
    return spec;
  },
  // New builders for the specs that were written inline in app/options.php (qa_preload_options())
  qa_db_options_selectspec() {
    return { columns: [[null, 'title'], [null, 'content']], source: '^options', arraykey: 'title', arrayvalue: 'content' };
  },
  qa_db_time_selectspec() {
    return { columns: [['title', "'db_time'"], ['content', 'UNIX_TIMESTAMP(NOW())']], arraykey: 'title', arrayvalue: 'content' };
  },
};

// qa_db_messages_columns()
function messageColumns() {
  return [[null, 'messageid'], [null, 'fromuserid'], [null, 'touserid'], [null, 'content'], [null, 'format'], ['created', 'UNIX_TIMESTAMP(^messages.created)'],
    ['fromflags', 'ufrom.flags'], ['fromlevel', 'ufrom.level'], ['fromemail', 'ufrom.email'], ['fromhandle', 'ufrom.handle'],
    ['fromavatarblobid', 'BINARY ufrom.avatarblobid'], ['fromavatarwidth', 'ufrom.avatarwidth'], ['fromavatarheight', 'ufrom.avatarheight'],
    ['toflags', 'uto.flags'], ['tolevel', 'uto.level'], ['toemail', 'uto.email'], ['tohandle', 'uto.handle'],
    ['toavatarblobid', 'BINARY uto.avatarblobid'], ['toavatarwidth', 'uto.avatarwidth'], ['toavatarheight', 'uto.avatarheight']];
}
// qa_db_messages_inbox_selectspec() / qa_db_messages_outbox_selectspec()
function messageBox(usercolumn, hiddencolumn, type, identifier, isuserid, start, limit) {
  let source = `^messages LEFT JOIN ^users ufrom ON fromuserid=ufrom.userid LEFT JOIN ^users uto ON touserid=uto.userid WHERE ${usercolumn}=${truthy(isuserid) ? '$' : '(SELECT userid FROM ^users WHERE handle=$ LIMIT 1)'} AND type=$ AND ${hiddencolumn}=0 ORDER BY ^messages.created DESC`;
  const args = [identifier, String(type).toUpperCase()];
  if (isset(limit)) { source += ' LIMIT #,#'; args.push(start, Math.min(Number(limit), QA_DB_RETRIEVE_MESSAGES)); }
  return { columns: messageColumns(), source, arguments: args, arraykey: 'messageid', sortdesc: 'created' };
}
// qa_db_selectspec_count()
function countSpec(spec) {
  const out = { ...spec, columns: [['count', 'COUNT(*)']], single: true };
  delete out.arraykey;
  return out;
}

module.exports = { builders, countSpec, ipHex, slugsToBackpath };
