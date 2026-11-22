<?php
// Generates php-post-rules-outputs.json: what Q2A's qa_page_q_post_rules() (pages/question-view.php) gives
// for a grid of posts, viewers and options, so tests/integration/post-common.test.js can hold
// postRules() in src/services/post-common.js to PHP's answers. Also qa_filter_basic's question, answer and
// comment checks. Runs in the PHP container without a database: options go into Q2A's option cache (any
// option PHP fills in with its default would be written to the database; that write is swallowed), the
// viewer into Q2A's user cache, and the visitor cookie into $_COOKIE.
//
//   scripts/php-fixtures.sh            (regenerates every generated fixture)
$qa_autoconnect = false;
require '/var/www/html/qa-include/qa-base.php';
require_once QA_INCLUDE_DIR . 'app/options.php';
require_once QA_INCLUDE_DIR . 'app/users.php';
require_once QA_INCLUDE_DIR . 'app/limits.php';
require_once QA_INCLUDE_DIR . 'app/format.php';
require_once QA_INCLUDE_DIR . 'app/cookies.php';
require_once QA_INCLUDE_DIR . 'app/updates.php';
require_once QA_INCLUDE_DIR . 'pages/question-view.php';
require_once QA_INCLUDE_DIR . 'plugins/qa-filter-basic.php';

$GLOBALS['qa_options_loaded'] = true;
$qa_overrides['qa_db_query_raw'] = 'swallow_query';
$qa_overrides['qa_db_escape_string'] = 'addslashes';
function swallow_query($query) { return true; }
$qa_overrides['qa_get_logged_in_userid'] = 'harness_userid';
$harnessUser = null;
function harness_userid() { global $harnessUser; return $harnessUser ? $harnessUser['userid'] : null; }
function set_options($values) { global $qa_options_cache; foreach ($values as $n => $v) $qa_options_cache[$n] = $v; }
function view_as($user, $cookie)
{
    global $harnessUser, $qa_cached_logged_in_user, $qa_db_pending_results, $qa_curr_ip_blocked;
    $harnessUser = $user;
    $qa_cached_logged_in_user = $user;
    $qa_db_pending_results['userlevels'] = array();
    $qa_curr_ip_blocked = null;
    if ($cookie === null) unset($_COOKIE['qa_id']); else $_COOKIE['qa_id'] = $cookie;
}
$_SERVER['REMOTE_ADDR'] = '9.9.9.9';

// Every option the rules read, at Q2A's defaults, so the Node test sees exactly what PHP saw.
$optionNames = array('do_close_on_select', 'allow_close_own_questions', 'allow_self_answer', 'comment_on_qs', 'comment_on_as', 'tags_or_categories',
    'flagging_of_posts', 'flagging_hide_after', 'allow_close_questions', 'allow_multi_answers', 'confirm_user_emails', 'moderate_users', 'block_ips_write',
    'permit_post_q', 'permit_post_a', 'permit_post_c', 'permit_edit_q', 'permit_edit_a', 'permit_edit_c', 'permit_retag_cat', 'permit_flag',
    'permit_hide_show', 'permit_close_q', 'permit_moderate', 'permit_select_a', 'permit_delete_hidden', 'min_len_q_title', 'max_len_q_title',
    'min_len_q_content', 'min_num_q_tags', 'max_num_q_tags', 'min_len_a_content', 'min_len_c_content');
foreach ($optionNames as $name) {
    $points = array();
    if (strpos($name, 'permit_') === 0) $points[] = $name . '_points';
    foreach (array_merge(array($name), $points) as $n) set_options(array($n => qa_default_option($n)));
}
$baseOptions = $qa_options_cache;
$optionSets = array(
    'defaults' => array(),
    'strict' => array('allow_self_answer' => '0', 'allow_multi_answers' => '0', 'comment_on_as' => '0', 'do_close_on_select' => '1', 'allow_close_own_questions' => '0',
        'flagging_of_posts' => '0', 'tags_or_categories' => 't', 'allow_close_questions' => '0'),
    'open' => array('permit_edit_q' => '120', 'permit_edit_a' => '120', 'permit_hide_show' => '120', 'permit_close_q' => '120', 'permit_moderate' => '100',
        'permit_select_a' => '100', 'permit_flag' => '150', 'permit_delete_hidden' => '70', 'permit_post_a' => '150', 'permit_post_c' => '110',
        'confirm_user_emails' => '1', 'moderate_users' => '1', 'tags_or_categories' => 'c', 'allow_self_answer' => '1', 'allow_multi_answers' => '1'),
    'points' => array('permit_edit_q' => '106', 'permit_edit_q_points' => '50', 'permit_retag_cat' => '104', 'permit_retag_cat_points' => '0',
        'permit_close_q' => '102', 'permit_close_q_points' => '10', 'confirm_user_emails' => '1', 'tags_or_categories' => '', 'block_ips_write' => '9.9.9.*'),
);
$viewers = array(
    'anon-cookie' => array(null, '111'), 'anon' => array(null, null),
    'user' => array(array('userid' => '5', 'level' => '0', 'flags' => '1', 'points' => '100'), '111'),
    'unconfirmed' => array(array('userid' => '5', 'level' => '0', 'flags' => '0', 'points' => '5'), null),
    'other' => array(array('userid' => '6', 'level' => '0', 'flags' => '1', 'points' => '0'), null),
    'expert' => array(array('userid' => '6', 'level' => '20', 'flags' => '1', 'points' => '0'), null),
    'editor' => array(array('userid' => '6', 'level' => '50', 'flags' => '1', 'points' => '0'), null),
    'moderator' => array(array('userid' => '6', 'level' => '80', 'flags' => '1', 'points' => '0'), null),
    'admin' => array(array('userid' => '6', 'level' => '100', 'flags' => '1', 'points' => '0'), null),
    'blocked' => array(array('userid' => '5', 'level' => '0', 'flags' => '3', 'points' => '0'), null),
);
$post = function ($changes) {
    return array_merge(array('postid' => '10', 'type' => 'Q', 'basetype' => 'Q', 'parentid' => null, 'userid' => '5', 'cookieid' => null, 'lastuserid' => null,
        'closedbyid' => null, 'selchildid' => null, 'hidden' => 0, 'queued' => 0, 'flagcount' => '0', 'userflag' => '0', 'categoryids' => ''), $changes);
};
$q = array('postid' => '1', 'type' => 'Q', 'basetype' => 'Q', 'userid' => '5', 'cookieid' => null);
$qOther = array('postid' => '1', 'type' => 'Q', 'basetype' => 'Q', 'userid' => '9', 'cookieid' => null);
$posts = array(
    'question by 5' => array($post(array()), null, null, null),
    'question by 9' => array($post(array('userid' => '9')), null, null, null),
    'anonymous question, cookie 111' => array($post(array('userid' => null, 'cookieid' => '111')), null, null, null),
    'anonymous question, cookie 222' => array($post(array('userid' => null, 'cookieid' => '222')), null, null, null),
    'closed by 9' => array($post(array('userid' => '9', 'closedbyid' => '3', 'lastuserid' => '4')), null, null, null),
    'closed by its author' => array($post(array('closedbyid' => '3', 'lastuserid' => '5')), null, null, null),
    'selected answer' => array($post(array('userid' => '9', 'selchildid' => '20')), null, null, null),
    'hidden by author' => array($post(array('hidden' => 1, 'lastuserid' => '5')), null, null, null),
    'hidden by other' => array($post(array('userid' => '9', 'hidden' => 1, 'lastuserid' => '4')), null, null, null),
    'hidden with flags' => array($post(array('userid' => '9', 'hidden' => 1, 'flagcount' => '2')), null, null, null),
    'queued' => array($post(array('userid' => '9', 'queued' => 1)), null, null, null),
    'queued own' => array($post(array('queued' => 1)), null, null, null),
    'flagged once' => array($post(array('userid' => '9', 'flagcount' => '1')), null, null, null),
    'flagged by you' => array($post(array('userid' => '9', 'flagcount' => '1', 'userflag' => '1')), null, null, null),
    'flagged twice, once by you' => array($post(array('userid' => '9', 'flagcount' => '2', 'userflag' => '1')), null, null, null),
    'question with your answer' => array($post(array('userid' => '9')), null, null, array(array('postid' => '20', 'parentid' => '10', 'basetype' => 'A', 'userid' => '5', 'cookieid' => null))),
    'hidden question with a comment' => array($post(array('hidden' => 1, 'lastuserid' => '5')), null, null, array(array('postid' => '21', 'parentid' => '10', 'basetype' => 'C', 'userid' => '9', 'cookieid' => null))),
    'children of another post' => array($post(array('hidden' => 1)), null, null, array(array('postid' => '22', 'parentid' => '99', 'basetype' => 'A', 'userid' => '5', 'cookieid' => null))),
    'answer by 9' => array($post(array('type' => 'A', 'basetype' => 'A', 'parentid' => '1', 'userid' => '9')), $q, null, null),
    'answer by 5' => array($post(array('type' => 'A', 'basetype' => 'A', 'parentid' => '1')), $qOther, null, null),
    'anonymous answer on your question' => array($post(array('type' => 'A', 'basetype' => 'A', 'parentid' => '1', 'userid' => null, 'cookieid' => '111')), $q, null, null),
    'anonymous answer, you answered too' => array($post(array('type' => 'A', 'basetype' => 'A', 'parentid' => '1', 'userid' => null, 'cookieid' => '111')), $qOther,
        array(array('postid' => '30', 'parentid' => '1', 'basetype' => 'A', 'userid' => '5', 'cookieid' => null), array('postid' => '31', 'parentid' => '2', 'basetype' => 'A', 'userid' => '5', 'cookieid' => null)), null),
    'anonymous answer, others answered' => array($post(array('type' => 'A', 'basetype' => 'A', 'parentid' => '1', 'userid' => null, 'cookieid' => '111')), $qOther,
        array(array('postid' => '30', 'parentid' => '1', 'basetype' => 'C', 'userid' => '5', 'cookieid' => null), array('postid' => '32', 'parentid' => '1', 'basetype' => 'A', 'userid' => '9', 'cookieid' => null)), null),
    'answer with comments' => array($post(array('type' => 'A', 'basetype' => 'A', 'parentid' => '1', 'userid' => '9', 'hidden' => 1)), $q, null,
        array(array('postid' => '40', 'parentid' => '10', 'basetype' => 'C', 'userid' => '5', 'cookieid' => null))),
    'comment by 9' => array($post(array('type' => 'C', 'basetype' => 'C', 'parentid' => '1', 'userid' => '9')), $q, null, null),
    'anonymous comment' => array($post(array('type' => 'C', 'basetype' => 'C', 'parentid' => '1', 'userid' => null, 'cookieid' => '111')), $q, null, null),
    'hidden question' => array($post(array('type' => 'Q_HIDDEN', 'userid' => '9', 'hidden' => 1)), null, null, null),
    'last edited by the author' => array($post(array('userid' => '9', 'lastuserid' => '9')), null, null, null),
    'hidden question others are closed as duplicates of' => array($post(array('hidden' => 1, 'lastuserid' => '5')), null, null,
        array(array('postid' => '50', 'parentid' => null, 'basetype' => 'Q', 'userid' => '9', 'cookieid' => null, 'closedbyid' => '10'))),
    'hidden question, an unrelated closed question' => array($post(array('hidden' => 1, 'lastuserid' => '5')), null, null,
        array(array('postid' => '51', 'parentid' => null, 'basetype' => 'Q', 'userid' => '9', 'cookieid' => null, 'closedbyid' => '77'))),
);
$keys = array('isbyuser', 'closed', 'authorlast', 'viewable', 'answerbutton', 'commentbutton', 'commentable', 'editbutton', 'editable', 'retagcatbutton',
    'retagcatable', 'aselectable', 'flagbutton', 'unflaggable', 'clearflaggable', 'closeable', 'reopenable', 'moderatable', 'hideable', 'reshowimmed',
    'reshowable', 'deleteable', 'claimable');
$out = array('note' => 'Generated by tests/fixtures/php-post-rules.php in the PHP container (scripts/php-fixtures.sh).', 'baseOptions' => $baseOptions,
    'optionSets' => $optionSets, 'viewers' => $viewers, 'posts' => $posts, 'keys' => $keys, 'rules' => array());
// Rows from the database always have closedbyid.
foreach ($posts as $postName => $args) foreach (array(2, 3) as $i) if (isset($args[$i])) foreach ($args[$i] as $k => $row) $posts[$postName][$i][$k] += array('closedbyid' => null);
$out['posts'] = $posts;
foreach ($optionSets as $setName => $set) foreach ($viewers as $viewerName => $viewer) foreach ($posts as $postName => $args) {
    $GLOBALS['qa_options_cache'] = $baseOptions;
    set_options($set);
    view_as($viewer[0], $viewer[1]);
    $rules = qa_page_q_post_rules($args[0], $args[1], $args[2], $args[3]);
    $bits = '';
    foreach ($keys as $key) $bits .= empty($rules[$key]) ? '0' : '1';
    $out['rules'][] = array($setName, $viewerName, $postName, $bits);
}

// qa_filter_basic: the checks on a question, answer or comment as posted.
$filter = new qa_filter_basic();
$filterSets = array(
    array(),
    array('min_len_q_title' => '20', 'max_len_q_title' => '30', 'min_len_q_content' => '10', 'min_num_q_tags' => '2', 'max_num_q_tags' => '3', 'min_len_a_content' => '5', 'min_len_c_content' => '3'),
    array('min_len_q_title' => '50', 'max_len_q_title' => '10', 'min_num_q_tags' => '5', 'max_num_q_tags' => '2', 'min_len_q_content' => '0'),
    array('max_len_q_title' => '2000'),
);
$titles = array('', 'Hi', 'A title of exactly twenty', str_repeat('t', 30), str_repeat('t', 31), str_repeat('t', 800), str_repeat('t', 801), str_repeat('é', 25));
$texts = array('', 'short', 'exactly ten', str_repeat('x', 12000), str_repeat('x', 12001));
$tagSets = array(null, array(), array('a'), array('a', 'b'), array('a', 'b', 'c', 'd'), array(str_repeat('t', 799)), array(str_repeat('t', 400), str_repeat('u', 400)));
$emails = array(array(false, null), array(true, ''), array(true, 'ok@example.test'), array(true, 'bad'), array(true, 'a@' . str_repeat('d', 60) . '.' . str_repeat('e', 13) . '.test'));
// Inputs are written once and the cases refer to them by index, so the fixture stays small.
$out['filterInputs'] = array('sets' => $filterSets, 'titles' => $titles, 'texts' => $texts, 'tagSets' => $tagSets, 'emails' => $emails);
foreach ($filterSets as $s => $set) {
    $GLOBALS['qa_options_cache'] = $baseOptions;
    set_options($set);
    foreach ($titles as $ti => $title) foreach (array(0, 1, 2) as $xi) foreach ($tagSets as $gi => $tags) {
        $question = array('title' => $title, 'content' => $texts[$xi], 'text' => $texts[$xi], 'notify' => false, 'email' => null);
        if (isset($tags)) $question['tags'] = $tags;
        $errors = array();
        $filter->filter_question($question, $errors, null);
        $out['filterQuestion'][] = array($s, $ti, $xi, $gi, 0, (object)$errors);
    }
    foreach ($emails as $ei => $email) {
        $question = array('title' => 'A good long title here', 'content' => 'content', 'text' => 'content', 'notify' => $email[0], 'email' => $email[1]);
        $errors = array();
        $filter->filter_question($question, $errors, null);
        $out['filterQuestion'][] = array($s, -1, -1, 0, $ei, (object)$errors);
    }
    foreach ($texts as $xi => $t) foreach ($emails as $ei => $email) {
        foreach (array('Answer', 'Comment') as $kind) {
            $post = array('content' => $t, 'text' => $t, 'notify' => $email[0], 'email' => $email[1]);
            $errors = array();
            if ($kind === 'Answer') $filter->filter_answer($post, $errors, null, null);
            else $filter->filter_comment($post, $errors, null, null, null);
            $out["filter$kind"][] = array($s, $xi, $ei, (object)$errors);
        }
    }
}

echo json_encode($out, JSON_UNESCAPED_UNICODE), "\n";
