<?php
if (!defined('QA_VERSION')) { http_response_code(404); exit; }

function qa_get_logged_in_userid()
{
    // Node is the authentication authority. PHP's own login cookies are ignored.
    static $checked = false;
    static $id = null;
    if (!$checked) {
        $checked = true;
        if (!empty($_COOKIE['q2a_node_bridge'])) {
            $result = node_bridge_request('me');
            if ($result['status'] === 200) $id = $result['data']['user']['id'];
        }
    }
    return $id;
}

function qa_get_request_content()
{
    $action = strtolower(qa_request());
    if ($action === 'logout') {
        $result = node_bridge_request('logout', new stdClass());
        if ($result['status'] !== 204) {
            $content = qa_content_prepare();
            $content['error'] = 'Authentication service unavailable. Logout could not be completed.';
            return $content;
        }
        node_bridge_cookie(null);
        header('X-Q2A-Auth-Backend: node-api-v1');
        qa_redirect('');
    }
    if (!in_array($action, array('login', 'register'), true) || !qa_clicked('do' . $action)) return qa_get_request_content_base();
    if (qa_is_logged_in()) qa_redirect('');
    header('X-Q2A-Auth-Backend: node-api-v1');
    // Preserve Q2A's existing form protection before forwarding any credentials.
    $valid = qa_check_form_security_code($action, qa_post_text('code'));
    $input = $action === 'login'
        ? array('emailhandle' => (string)qa_post_text('emailhandle'), 'password' => (string)qa_post_text('password'), 'remember' => (bool)qa_post_text('remember'))
        : array('handle' => (string)qa_post_text('handle'), 'email' => (string)qa_post_text('email'), 'password' => (string)qa_post_text('password'));
    // Render the original controller without executing its PHP authentication writes.
    unset($_POST['do' . $action]);
    unset($_POST['password']);
    if (!$valid) {
        $content = qa_get_request_content_base();
        $content['error'] = qa_lang_html('misc/form_security_again');
        return $content;
    }
    $result = node_bridge_request($action, $input);
    if (in_array($result['status'], array(200, 201), true) && $result['token']) {
        node_bridge_cookie($result['token'], !empty($input['remember']));
        qa_redirect('');
    }
    return node_bridge_errors(qa_get_request_content_base(), $result, $input, $action);
}

// Voting. Both callers (ajax/vote.php and qa_check_page_clicks() in app/page.php) call
// qa_vote_error_html() and, only if it returns false, qa_vote_set(). Node performs the check and
// the write in one request, so the check override sends the vote and qa_vote_set() skips a repeat.
function node_bridge_vote_value($vote)
{
    return (int)min(1, max(-1, $vote)); // the same clamping as qa_vote_set()
}

function qa_vote_error_html($post, $vote, $userid, $topage)
{
    global $node_bridge_applied_votes;
    if (!is_array($post)) return qa_lang_html('main/vote_not_allowed'); // as PHP does for a missing post
    $vote = node_bridge_vote_value($vote);
    $error = node_bridge_vote($post['postid'], $vote, $topage);
    if ($error === false) $node_bridge_applied_votes[$post['postid']] = $vote;
    return $error;
}

function qa_vote_set($post, $userid, $handle, $cookieid, $vote)
{
    global $node_bridge_applied_votes;
    $vote = node_bridge_vote_value($vote);
    if (isset($node_bridge_applied_votes[$post['postid']]) && $node_bridge_applied_votes[$post['postid']] === $vote) return;
    $error = node_bridge_vote($post['postid'], $vote, qa_request());
    if ($error !== false) qa_fatal_error('Node vote failed: ' . strip_tags($error));
}

// Posting. The page controllers (pages/ask.php, pages/question-submit.php) still validate the form
// so they can redisplay it with errors; the create functions they call are sent to Node.
function qa_cookie_get_create()
{
    // Node checks the visitor cookie and creates one if needed when the post is made.
    return qa_cookie_get();
}

function qa_question_create($followanswer, $userid, $handle, $cookieid, $title, $content, $format, $text, $tagstring, $notify, $email,
    $categoryid = null, $extravalue = null, $queued = false, $name = null)
{
    $body = node_bridge_post_body($content, $format, $notify, $email, $name);
    $body['title'] = (string)$title;
    $body['tags'] = qa_tagstring_to_tags($tagstring);
    $body['categoryid'] = isset($categoryid) ? (int)$categoryid : null;
    $body['followAnswerId'] = isset($followanswer['postid']) ? (int)$followanswer['postid'] : null;
    if (isset($extravalue)) $body['extra'] = (string)$extravalue;
    return node_bridge_create_post('/api/v1/questions', $body);
}

function qa_answer_create($userid, $handle, $cookieid, $content, $format, $text, $notify, $email, $question, $queued = false, $name = null)
{
    return node_bridge_create_post('/api/v1/questions/' . (int)$question['postid'] . '/answers',
        node_bridge_post_body($content, $format, $notify, $email, $name));
}

function qa_comment_create($userid, $handle, $cookieid, $content, $format, $text, $notify, $email, $question, $parent, $commentsfollows, $queued = false, $name = null)
{
    $parentid = isset($parent) ? $parent['postid'] : $question['postid'];
    return node_bridge_create_post('/api/v1/posts/' . (int)$parentid . '/comments',
        node_bridge_post_body($content, $format, $notify, $email, $name));
}

// Editing. pages/question-post.php validates each edit form for redisplay, then calls these.
function qa_question_set_content($oldquestion, $title, $content, $format, $text, $tagstring, $notify, $userid, $handle, $cookieid, $extravalue = null, $name = null, $remoderate = false, $silent = false)
{
    global $node_bridge_moved_questions;
    $body = node_bridge_edit_body($content, $format, $notify, $name, $silent);
    $body['title'] = (string)$title;
    $body['tags'] = qa_tagstring_to_tags($tagstring);
    if (isset($extravalue)) $body['extra'] = (string)$extravalue;
    // The page moves the question with a separate call; Node takes the new category with the edit.
    if (qa_using_categories() && qa_post_text('q_dosave') !== null) {
        $categoryid = qa_get_category_field_value('q_category');
        $body['categoryid'] = strlen((string)$categoryid) ? (int)$categoryid : null;
        $node_bridge_moved_questions[$oldquestion['postid']] = true;
    }
    node_bridge_change_post('PATCH', '/api/v1/posts/' . (int)$oldquestion['postid'], $body);
}

function qa_question_set_category($oldquestion, $categoryid, $userid, $handle, $cookieid, $answers, $commentsfollows, $closepost = null, $silent = false)
{
    global $node_bridge_moved_questions;
    if (!empty($node_bridge_moved_questions[$oldquestion['postid']])) return; // already sent with the edit
    node_bridge_change_post('PATCH', '/api/v1/posts/' . (int)$oldquestion['postid'],
        array('categoryid' => isset($categoryid) ? (int)$categoryid : null, 'silent' => (bool)$silent));
}

function qa_answer_set_content($oldanswer, $content, $format, $text, $notify, $userid, $handle, $cookieid, $question, $name = null, $remoderate = false, $silent = false)
{
    node_bridge_change_post('PATCH', '/api/v1/posts/' . (int)$oldanswer['postid'], node_bridge_edit_body($content, $format, $notify, $name, $silent));
}

function qa_answer_to_comment($oldanswer, $parentid, $content, $format, $text, $notify, $userid, $handle, $cookieid, $question, $answers, $commentsfollows, $name = null, $remoderate = false, $silent = false)
{
    $body = node_bridge_edit_body($content, $format, $notify, $name, $silent);
    $body['convertToCommentOn'] = (int)$parentid;
    node_bridge_change_post('PATCH', '/api/v1/posts/' . (int)$oldanswer['postid'], $body);
}

function qa_comment_set_content($oldcomment, $content, $format, $text, $notify, $userid, $handle, $cookieid, $question, $parent, $name = null, $remoderate = false, $silent = false)
{
    node_bridge_change_post('PATCH', '/api/v1/posts/' . (int)$oldcomment['postid'], node_bridge_edit_body($content, $format, $notify, $name, $silent));
}

// Selecting, closing, hiding/approving, deleting and claiming. Posts hidden by flags are hidden by
// Node itself when the flag is set (see qa_flag_set_tohide below); a call with no user can still come
// from a plugin calling these functions directly, and stays in PHP.
function node_bridge_is_system($userid, $cookieid)
{
    return !isset($userid) && !isset($cookieid);
}

function qa_question_set_selchildid($userid, $handle, $cookieid, $oldquestion, $selchildid, $answers)
{
    if (node_bridge_is_system($userid, $cookieid)) return qa_question_set_selchildid_base($userid, $handle, $cookieid, $oldquestion, $selchildid, $answers);
    node_bridge_change_post('PUT', '/api/v1/questions/' . (int)$oldquestion['postid'] . '/selected-answer', array('answerId' => isset($selchildid) ? (int)$selchildid : null));
}

function qa_question_close_clear($oldquestion, $oldclosepost, $userid, $handle, $cookieid)
{
    if (node_bridge_is_system($userid, $cookieid)) return qa_question_close_clear_base($oldquestion, $oldclosepost, $userid, $handle, $cookieid);
    node_bridge_change_post('DELETE', '/api/v1/questions/' . (int)$oldquestion['postid'] . '/close', new stdClass());
}

function qa_question_close_duplicate($oldquestion, $oldclosepost, $originalpostid, $userid, $handle, $cookieid)
{
    // Node reads the duplicate's ID from a link to it, as the close form does.
    node_bridge_change_post('POST', '/api/v1/questions/' . (int)$oldquestion['postid'] . '/close', array('details' => qa_path_absolute((string)(int)$originalpostid)));
}

function qa_question_close_other($oldquestion, $oldclosepost, $note, $userid, $handle, $cookieid)
{
    node_bridge_change_post('POST', '/api/v1/questions/' . (int)$oldquestion['postid'] . '/close', array('details' => (string)$note));
}

// The click that led here, from the old type and the new status (Node decides a reshown post's status itself).
function node_bridge_status_action($oldtype, $status)
{
    $queued = substr($oldtype, 1) === '_QUEUED';
    if ($status == QA_POST_STATUS_HIDDEN) return $queued ? 'reject' : 'hide';
    return $queued ? 'approve' : 'reshow';
}

function qa_question_set_status($oldquestion, $status, $userid, $handle, $cookieid, $answers, $commentsfollows, $closepost = null)
{
    if (node_bridge_is_system($userid, $cookieid)) return qa_question_set_status_base($oldquestion, $status, $userid, $handle, $cookieid, $answers, $commentsfollows, $closepost);
    node_bridge_change_post('POST', '/api/v1/posts/' . (int)$oldquestion['postid'] . '/status', array('action' => node_bridge_status_action($oldquestion['type'], $status)));
}

function qa_answer_set_status($oldanswer, $status, $userid, $handle, $cookieid, $question, $commentsfollows)
{
    if (node_bridge_is_system($userid, $cookieid)) return qa_answer_set_status_base($oldanswer, $status, $userid, $handle, $cookieid, $question, $commentsfollows);
    node_bridge_change_post('POST', '/api/v1/posts/' . (int)$oldanswer['postid'] . '/status', array('action' => node_bridge_status_action($oldanswer['type'], $status)));
}

function qa_comment_set_status($oldcomment, $status, $userid, $handle, $cookieid, $question, $parent)
{
    if (node_bridge_is_system($userid, $cookieid)) return qa_comment_set_status_base($oldcomment, $status, $userid, $handle, $cookieid, $question, $parent);
    node_bridge_change_post('POST', '/api/v1/posts/' . (int)$oldcomment['postid'] . '/status', array('action' => node_bridge_status_action($oldcomment['type'], $status)));
}

function qa_question_delete($oldquestion, $userid, $handle, $cookieid, $oldclosepost = null)
{
    node_bridge_change_post('DELETE', '/api/v1/posts/' . (int)$oldquestion['postid'], new stdClass());
}

function qa_answer_delete($oldanswer, $question, $userid, $handle, $cookieid)
{
    node_bridge_change_post('DELETE', '/api/v1/posts/' . (int)$oldanswer['postid'], new stdClass());
}

function qa_comment_delete($oldcomment, $question, $parent, $userid, $handle, $cookieid)
{
    node_bridge_change_post('DELETE', '/api/v1/posts/' . (int)$oldcomment['postid'], new stdClass());
}

function qa_question_set_userid($oldquestion, $userid, $handle, $cookieid)
{
    node_bridge_change_post('POST', '/api/v1/posts/' . (int)$oldquestion['postid'] . '/claim', new stdClass());
}

function qa_answer_set_userid($oldanswer, $userid, $handle, $cookieid)
{
    node_bridge_change_post('POST', '/api/v1/posts/' . (int)$oldanswer['postid'] . '/claim', new stdClass());
}

function qa_comment_set_userid($oldcomment, $userid, $handle, $cookieid)
{
    node_bridge_change_post('POST', '/api/v1/posts/' . (int)$oldcomment['postid'] . '/claim', new stdClass());
}

// Flags. The page still runs qa_flag_error_html() so it can show its message; Node checks again,
// sets the flag and, when the post has enough flags, hides it in the same transaction. Returning
// false stops the page from hiding it a second time.
function qa_flag_set_tohide($oldpost, $userid, $handle, $cookieid, $question)
{
    node_bridge_change_post('PUT', '/api/v1/posts/' . (int)$oldpost['postid'] . '/flag', new stdClass());
    return false;
}

function qa_flag_clear($oldpost, $userid, $handle, $cookieid)
{
    node_bridge_change_post('DELETE', '/api/v1/posts/' . (int)$oldpost['postid'] . '/flag', new stdClass());
}

function qa_flags_clear_all($oldpost, $userid, $handle, $cookieid)
{
    node_bridge_change_post('DELETE', '/api/v1/posts/' . (int)$oldpost['postid'] . '/flags', new stdClass());
}

// Favorites, from the favorite buttons (app/page.php) and their ajax version (ajax/favorite.php).
function qa_user_favorite_set($userid, $handle, $cookieid, $entitytype, $entityid, $favorite)
{
    // Q2A silently ignores following yourself; Node refuses it, so keep PHP's no-op here.
    if ($entitytype == 'U' && $userid == $entityid) return; // QA_ENTITY_USER
    node_bridge_favorite($entitytype, $entityid, (bool)$favorite);
}

// Private messages and wall posts. The pages still run their own checks (qa_wall_error_html(), the
// message page's permission switch) so they can show their messages; Node checks again and writes.
function qa_pm_send($userid, $handle, $cookieid, $toaccount, $message)
{
    // Node saves the message and emails the recipient; the page reports whether the email went out.
    $result = node_bridge_message('POST', '/api/v1/users/' . rawurlencode($toaccount['handle']) . '/messages', array('content' => (string)$message));
    return !empty($result['emailed']);
}

function qa_wall_add_post($userid, $handle, $cookieid, $touserid, $tohandle, $content, $format)
{
    $result = node_bridge_message('POST', '/api/v1/users/' . rawurlencode($tohandle) . '/wall', array('content' => (string)$content));
    return $result['id'];
}

function qa_wall_delete_post($userid, $handle, $cookieid, $message)
{
    node_bridge_message('DELETE', '/api/v1/wall-posts/' . (int)$message['messageid'], new stdClass());
}

function qa_pm_delete($userid, $handle, $cookieid, $message, $box)
{
    node_bridge_message('DELETE', '/api/v1/messages/' . ($box === 'inbox' ? 'inbox' : 'outbox') . '/' . (int)$message['messageid'], new stdClass());
}

// Account and profile. The pages still check their forms (handle and email filters, the current
// password, password length) so they can show their own messages; Node checks again and writes.
function qa_user_save_profile($userid, $useraccount, $isblocked, $handle, $email, $messages, $wallposts, $mailings, $avatar, $userfields, $profile, $errors, $doconfirms)
{
    $body = array('handle' => (string)$handle, 'email' => (string)$email);
    if (!$isblocked) {
        $body += array('messages' => (bool)$messages, 'wallPosts' => (bool)$wallposts, 'mailings' => (bool)$mailings, 'avatar' => (string)$avatar, 'profile' => array());
        foreach ($userfields as $userfield) $body['profile'][$userfield['title']] = (string)@$profile[$userfield['fieldid']];
        if (!count($body['profile'])) $body['profile'] = new stdClass();
    }
    $result = node_bridge_account('PATCH', '', $body);
    if ($result['status'] !== 200) qa_fatal_error('Node could not save the profile: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
    return !isset($errors['email']) && $email !== $useraccount['email'];
}

function qa_user_upload_avatar($userid, $imagefile, $oldblobid)
{
    $result = node_bridge_upload('/api/v1/account/avatar', $imagefile);
    if ($result['status'] === 200) return null;
    switch ($result['data']['error']['code'] ?? '') {
        case 'upload_limit': return qa_lang('main/upload_limit');
        case 'no_permission': return qa_lang('users/no_permission');
        case 'payload_too_large': return qa_lang('main/file_upload_limit_exceeded');
        default:
            require_once QA_INCLUDE_DIR . 'util/image.php';
            return qa_lang_sub('main/image_not_read', implode(', ', qa_gd_image_formats()));
    }
}

function qa_user_change_password($userid, $useraccount, $oldpassword, $newpassword)
{
    // Node keeps this session and ends the user's others.
    $result = node_bridge_account('PUT', '/password', array('oldPassword' => (string)$oldpassword, 'newPassword' => (string)$newpassword));
    if ($result['status'] !== 200) qa_fatal_error('Node could not change the password: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
}

function qa_user_unsubscribe($userid)
{
    // A signed-in user needs nothing more; otherwise Node checks the code from the email link.
    $body = qa_is_logged_in() ? new stdClass() : array('handle' => (string)qa_post_text('handle'), 'code' => trim((string)qa_post_text('code')));
    $result = node_bridge_account('POST', '/unsubscribe', $body);
    if ($result['status'] !== 200) qa_fatal_error('Node could not unsubscribe the user: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
}

function qa_send_new_confirm($userid)
{
    $result = node_bridge_account('POST', '/confirmation-email', new stdClass());
    if ($result['status'] !== 200) qa_fatal_error('Could not send email confirmation');
}

function qa_complete_confirm($userid, $email, $handle)
{
    // pages/confirm.php matched the code from the link; Node matches it again.
    $code = trim((string)(qa_post_text('code') ?? qa_get('c')));
    $result = node_bridge_account('POST', '/confirm-email', array('handle' => (string)$handle, 'code' => $code));
    if ($result['status'] !== 200) qa_fatal_error('Node could not confirm the email address: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
}

function qa_start_reset_user($userid)
{
    $result = node_bridge_account('POST', '/password-reset', array('emailHandle' => (string)qa_post_text('emailhandle')));
    if ($result['status'] !== 200) qa_fatal_error('Could not send reset password email');
}

function qa_finish_reset_user($userId, $newPassword)
{
    // pages/reset.php matched the code; Node checks it again, sets the password and signs the user in.
    $result = node_bridge_account('POST', '/password-reset/complete', array(
        'emailHandle' => trim((string)(qa_post_text('emailhandle') ?? qa_get('e'))),
        'code' => trim((string)(qa_post_text('code') ?? qa_get('c'))),
        'newPassword' => (string)$newPassword,
    ));
    if ($result['status'] !== 200 || empty($result['token'])) qa_fatal_error('Node could not reset the password: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
    node_bridge_cookie($result['token']);
}

// The feedback form: Node emails the site's feedback address.
function qa_send_feedback($userid, $handle, $cookieid, $message, $name, $email, $referer)
{
    header('X-Q2A-Feedback-Backend: node-api-v1');
    $result = node_bridge_api('POST', '/api/v1/feedback', array(
        'message' => (string)$message, 'name' => (string)$name, 'email' => (string)$email, 'referer' => (string)$referer,
        'browser' => (string)@$_SERVER['HTTP_USER_AGENT'],
    ));
    return $result['status'] === 200;
}

// Moderating and administering users (the profile page's admin form and buttons, and the approve
// users page). The pages decide which buttons to show; Node checks the same rules again.
function node_bridge_user_admin($method, $handle, $path, $body)
{
    header('X-Q2A-Admin-Backend: node-api-v1');
    $result = node_bridge_api($method, '/api/v1/users/' . rawurlencode((string)$handle) . $path, $body);
    if ($result['status'] !== 200) qa_fatal_error('Node could not change the user: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
    return $result['data'];
}

function node_bridge_handle($userid, $userAccount = null)
{
    if (is_array($userAccount) && isset($userAccount['handle'])) return $userAccount['handle'];
    if (is_string($userAccount)) return $userAccount;
    $handles = qa_userids_to_handles(array($userid));
    return $handles[$userid] ?? '';
}

function qa_set_user_level($userid, $handle, $level, $userAccount)
{
    node_bridge_user_admin('PUT', $handle, '/level', array('level' => (int)$level));
}

function qa_set_user_blocked($userid, $userAccount, $blocked)
{
    node_bridge_user_admin($blocked ? 'PUT' : 'DELETE', node_bridge_handle($userid, $userAccount), '/block', new stdClass());
}

function qa_set_user_category_levels($userid, $userlevels)
{
    $levels = array();
    foreach ($userlevels as $userlevel) $levels[] = array('categoryid' => (int)$userlevel['entityid'], 'level' => (int)$userlevel['level']);
    node_bridge_user_admin('PUT', node_bridge_handle($userid), '/level', array('categoryLevels' => $levels));
}

function qa_user_admin_save($userid, $useraccount, $removeavatar, $fieldseditable, $email, $userfields, $profile, $errors)
{
    $body = array('removeAvatar' => (bool)$removeavatar);
    if ($fieldseditable) {
        $body['email'] = (string)$email;
        $body['profile'] = array();
        foreach ($userfields as $userfield) $body['profile'][$userfield['title']] = (string)@$profile[$userfield['fieldid']];
        if (!count($body['profile'])) $body['profile'] = new stdClass();
    }
    node_bridge_user_admin('PATCH', $useraccount['handle'], '', $body);
}

function qa_delete_user($userid, array $userAccount = null)
{
    node_bridge_user_admin('DELETE', node_bridge_handle($userid, $userAccount), '', new stdClass());
}

// Site administration: the admin option forms. The page lists the section's options; Node applies
// their types, limits and tidying, and saves them.
function node_bridge_site_admin($method, $path, $body)
{
    header('X-Q2A-Admin-Backend: node-api-v1');
    $result = node_bridge_api($method, '/api/v1/admin' . $path, $body);
    if ($result['status'] !== 200) qa_fatal_error('Node could not change the site settings: ' . ($result['data']['error']['code'] ?? 'service_unavailable') . ' ' . json_encode($result['data']['error']['fields'] ?? array()));
    return $result['data'];
}

function qa_admin_set_options($names, $types, $maximums, $minimums)
{
    $values = array();
    foreach ($names as $name) $values[$name] = qa_post_text('option_' . $name);
    $result = node_bridge_site_admin('PUT', '/options', array('values' => count($values) ? $values : new stdClass()));
    return !empty($result['recalcHotness']);
}

function qa_reset_options($names)
{
    // The defaults that depend on this site's address and installed plugins are worked out here.
    require_once QA_INCLUDE_DIR . 'app/format.php';
    $editor = '-';
    qa_load_editor('', 'html', $editor);
    $captchas = qa_list_modules('captcha');
    node_bridge_site_admin('POST', '/options/reset', array('names' => array_values($names), 'site' => array(
        'host' => (string)@$_SERVER['HTTP_HOST'],
        'https' => (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (!empty($_SERVER['HTTP_X_FORWARDED_SSL']) && $_SERVER['HTTP_X_FORWARDED_SSL'] === 'on') || (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https'),
        'directory' => strtr(rtrim(dirname($_SERVER['SCRIPT_NAME']), '/'), '\\', '/'),
        'htmlEditor' => $editor,
        'captchaModule' => count($captchas) ? reset($captchas) : '',
    )));
}

function qa_admin_set_default_avatar($imagefile)
{
    $result = node_bridge_upload('/api/v1/admin/default-avatar', $imagefile);
    if ($result['status'] === 200) return null;
    require_once QA_INCLUDE_DIR . 'util/image.php';
    return qa_lang_sub('main/image_not_read', implode(', ', qa_gd_image_formats()));
}

// Categories (admin/categories). The page checks the form and works out the slug; Node checks again.
function qa_admin_save_category($editcategory, $setparent, $hassubcategory, $parentid, $name, $slug, $content, $position)
{
    $body = array('name' => (string)$name, 'slug' => (string)$slug, 'content' => $content, 'position' => isset($position) ? (string)$position : null,
        'parentid' => strlen((string)$parentid) ? (int)$parentid : null, 'setParent' => (bool)$setparent);
    $result = isset($editcategory['categoryid'])
        ? node_bridge_site_admin('PUT', '/categories/' . (int)$editcategory['categoryid'], $body)
        : node_bridge_site_admin('POST', '/categories', $body);
    return array($result['categoryid'], !empty($result['recalc']));
}

function qa_admin_delete_category($categoryid, $reassignid)
{
    node_bridge_site_admin('DELETE', '/categories/' . (int)$categoryid, array('reassignTo' => strlen((string)$reassignid) ? (int)$reassignid : null));
}

function qa_admin_reassign_category($categoryid, $reassignid)
{
    node_bridge_site_admin('POST', '/categories/' . (int)$categoryid . '/reassign', array('reassignTo' => strlen((string)$reassignid) ? (int)$reassignid : null));
}

// Custom pages and links, widgets, user titles and user fields. The pages check their forms; Node
// checks again and saves.
function qa_admin_save_page($editpage, $isexternal, $name, $position, $permit, $url, $newwindow, $heading, $slug, $content, $errors)
{
    if (!isset($editpage['pageid']) && !empty($errors)) return null;
    $body = array('external' => (bool)$isexternal, 'name' => (string)$name, 'position' => (string)$position, 'permit' => (int)$permit,
        'url' => $url, 'newWindow' => (bool)$newwindow, 'heading' => $heading, 'slug' => $slug, 'content' => $content);
    $result = isset($editpage['pageid'])
        ? node_bridge_site_admin('PUT', '/pages/' . (int)$editpage['pageid'], $body)
        : node_bridge_site_admin('POST', '/pages', $body);
    return $result['pageid'];
}

function qa_admin_delete_page($pageid)
{
    node_bridge_site_admin('DELETE', '/pages/' . (int)$pageid, new stdClass());
}

function qa_admin_save_widget($editwidget, $title, $tags, $position)
{
    $body = array('title' => (string)$title, 'templates' => strlen((string)$tags) ? explode(',', $tags) : array(), 'position' => (string)$position);
    $result = isset($editwidget['widgetid'])
        ? node_bridge_site_admin('PUT', '/widgets/' . (int)$editwidget['widgetid'], $body)
        : node_bridge_site_admin('POST', '/widgets', $body);
    return $result['widgetid'];
}

function qa_admin_delete_widget($widgetid)
{
    node_bridge_site_admin('DELETE', '/widgets/' . (int)$widgetid, new stdClass());
}

function qa_admin_save_user_title($pointstitle, $oldpoints, $remove, $title, $points)
{
    $result = node_bridge_site_admin('POST', '/user-titles', array(
        'oldPoints' => strlen((string)$oldpoints) ? (int)$oldpoints : null, 'remove' => (bool)$remove, 'title' => $title, 'points' => $points,
    ));
    $titles = array();
    foreach ($result['titles'] ?? array() as $p => $t) $titles[(int)$p] = $t;
    krsort($titles, SORT_NUMERIC);
    $errors = array();
    foreach ($result['errors'] ?? array() as $field => $code)
        $errors[$field] = $code === 'exists' ? qa_lang('admin/title_already_used') : qa_lang('main/field_required');
    return array($errors, $titles);
}

function qa_admin_save_userfield($editfield, $name, $flags, $position, $permit, $errors, $userfields)
{
    $body = array('name' => (string)$name, 'type' => (int)$flags & ~QA_FIELD_FLAGS_ON_REGISTER, 'onRegister' => (bool)((int)$flags & QA_FIELD_FLAGS_ON_REGISTER),
        'position' => $position, 'permit' => (int)$permit);
    $result = isset($editfield['fieldid'])
        ? node_bridge_site_admin('PUT', '/user-fields/' . (int)$editfield['fieldid'], $body)
        : node_bridge_site_admin('POST', '/user-fields', $body);
    return $result['fieldid'];
}

function qa_admin_delete_userfield($fieldid)
{
    node_bridge_site_admin('DELETE', '/user-fields/' . (int)$fieldid, new stdClass());
}

// The recalculation tools (admin/stats, admin/recalc and its ajax version). The file cache belongs to
// these PHP pages, so clearing or trimming it stays here; everything else runs in Node.
function qa_recalc_perform_steps($state, $seconds)
{
    if (strpos((string)$state, 'docache') === 0) return qa_recalc_perform_steps_base($state, $seconds);
    $result = node_bridge_site_admin('POST', '/recalc', array('state' => (string)$state, 'seconds' => (int)$seconds));
    return (string)$result['state'];
}

// Mailings (admin/mailing and its ajax steps) and enabling plugins.
function qa_mailing_start()
{
    node_bridge_site_admin('POST', '/mailing/start', new stdClass());
}

function qa_mailing_stop()
{
    node_bridge_site_admin('POST', '/mailing/stop', new stdClass());
}

function qa_mailing_perform_step()
{
    node_bridge_site_admin('POST', '/mailing/step', new stdClass());
}

function qa_mailing_send_one($userid, $handle, $email, $emailcode)
{
    // The page only sends one message itself: the test to the signed-in admin.
    $result = node_bridge_site_admin('POST', '/mailing/test', new stdClass());
    return !empty($result['sent']);
}

function qa_admin_set_enabled_plugins($directories)
{
    node_bridge_site_admin('PUT', '/plugins', array('directories' => array_values($directories)));
}

