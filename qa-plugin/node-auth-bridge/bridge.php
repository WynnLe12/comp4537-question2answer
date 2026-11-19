<?php
if (!defined('QA_VERSION')) { http_response_code(404); exit; }

function node_bridge_valid_token($token)
{
    return is_string($token) && strlen($token) <= 2048 &&
        preg_match('/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/D', $token);
}

function node_bridge_request($action, $body = null)
{
    return node_bridge_api($body === null ? 'GET' : 'POST', '/api/v1/auth/' . $action, $body);
}

// Calls the Node API server to server. The browser's address is forwarded so Node records
// the same IP that PHP's qa_remote_ip_address() would (Node trusts it only from TRUST_PROXY).
function node_bridge_api($method, $path, $body = null)
{
    $token = $_COOKIE['q2a_node_bridge'] ?? '';
    $headers = "Accept: application/json\r\n";
    $cookies = array();
    if (node_bridge_valid_token($token)) $cookies[] = 'q2a_node_session=' . $token;
    // Q2A's anonymous visitor cookie, so Node can tie anonymous posts to the same visitor.
    if (isset($_COOKIE['qa_id']) && preg_match('/^\d{1,20}$/D', $_COOKIE['qa_id'])) $cookies[] = 'qa_id=' . $_COOKIE['qa_id'];
    if ($cookies) $headers .= 'Cookie: ' . implode('; ', $cookies) . "\r\n";
    if (isset($_SERVER['REMOTE_ADDR']) && filter_var($_SERVER['REMOTE_ADDR'], FILTER_VALIDATE_IP)) $headers .= "X-Forwarded-For: " . $_SERVER['REMOTE_ADDR'] . "\r\n";
    if ($body !== null) $headers .= "Content-Type: application/json\r\nX-Q2A-Request: 1\r\n";
    $context = stream_context_create(array('http' => array(
        'method' => $method, 'header' => $headers,
        'content' => $body === null ? '' : json_encode($body),
        'ignore_errors' => true, 'timeout' => 5, 'follow_location' => 0,
    )));
    $raw = @file_get_contents(rtrim(getenv('NODE_AUTH_API'), '/') . $path, false, $context);
    $status = 503;
    $cookie = null;
    foreach ($http_response_header ?? array() as $header) {
        if (preg_match('/^HTTP\/\S+ (\d+)/', $header, $match)) $status = (int)$match[1];
        if (preg_match('/^Set-Cookie: q2a_node_session=([^;]+);/i', $header, $match) && node_bridge_valid_token($match[1])) $cookie = $match[1];
        // A visitor cookie Node created for an anonymous post is passed on to the browser, as qa_cookie_get_create() does.
        if (preg_match('/^Set-Cookie: qa_id=(\d{1,20});/i', $header, $match)) {
            setcookie('qa_id', $match[1], time() + 86400 * 365, '/', QA_COOKIE_DOMAIN, (bool)ini_get('session.cookie_secure'), true);
            $_COOKIE['qa_id'] = $match[1];
        }
    }
    return array('status' => $status, 'data' => json_decode($raw ?: '{}', true), 'token' => $cookie);
}

function node_bridge_cookie($token, $remember = false)
{
    setcookie('q2a_node_bridge', $token ?: '', array(
        'expires' => $token ? ($remember ? time() + 30 * 86400 : 0) : time() - 3600,
        'path' => '/', 'httponly' => true, 'samesite' => 'Strict',
        'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    ));
}

function node_bridge_errors($content, $result, $input, $action)
{
    if ($result['status'] === 401) $content['error'] = 'Incorrect username/email or password.';
    elseif ($result['status'] === 429) $content['error'] = 'Too many attempts. Please try again later.';
    elseif ($result['status'] >= 500) $content['error'] = 'Authentication service unavailable. Please try again.';
    else $content['error'] = 'Please check the highlighted fields.';
    foreach ($input as $field => $value) {
        $key = $field === 'emailhandle' ? 'email_handle' : $field;
        if (isset($content['form']['fields'][$key]) && $field !== 'password') $content['form']['fields'][$key]['value'] = qa_html((string)$value);
    }
    foreach ($result['data']['error']['fields'] ?? array() as $field => $reason) {
        $key = $field === 'emailhandle' ? 'email_handle' : $field;
        if (isset($content['form']['fields'][$key])) {
            $message = $reason === 'exists' ? qa_lang('users/' . $field . '_exists') : ($field === 'password' ? qa_lang_sub('users/password_min', 8) : 'Please enter a valid ' . $field . '.');
            $content['form']['fields'][$key]['error'] = qa_html($message);
        }
    }
    return $content;
}

// Sends a vote to Node and returns false on success, or the same HTML error qa_vote_error_html() shows.
function node_bridge_vote($postid, $vote, $topage)
{
    header('X-Q2A-Vote-Backend: node-api-v1');
    $result = node_bridge_api('PUT', '/api/v1/posts/' . (int)$postid . '/vote', array('vote' => $vote));
    if ($result['status'] === 200) return false;
    switch ($result['data']['error']['code'] ?? '') {
        case 'vote_disabled_hidden': return qa_lang_html('main/vote_disabled_hidden');
        case 'vote_disabled_queued': return qa_lang_html('main/vote_disabled_queued');
        case 'vote_not_allowed':
        case 'post_not_found': return qa_lang_html('main/vote_not_allowed');
        case 'unauthenticated': return qa_insert_login_links(qa_lang_html('main/vote_must_login'), $topage);
        case 'vote_must_confirm': return qa_insert_login_links(qa_lang_html('main/vote_must_confirm'), $topage);
        case 'vote_down_must_confirm': return qa_insert_login_links(qa_lang_html('main/vote_down_must_confirm'), $topage);
        case 'vote_limit': return qa_lang_html('main/vote_limit');
        case 'no_permission': return qa_lang_html('users/no_permission');
    }
    return 'Voting service unavailable. Please try again.';
}

// Creates a question, answer or comment in Node and returns the new post ID. The PHP page has
// already run its own checks for display; Node runs every check again and does all the writes.
function node_bridge_create_post($path, $body)
{
    header('X-Q2A-Post-Backend: node-api-v1');
    $result = node_bridge_api('POST', $path, $body);
    if ($result['status'] === 201 && isset($result['data']['id'])) return (int)$result['data']['id'];
    $code = $result['data']['error']['code'] ?? 'service_unavailable';
    qa_fatal_error('Node could not create the post: ' . $code . ' ' . json_encode($result['data']['error']['fields'] ?? array()));
}

// The fields every post type sends, as Q2A's form and editor produced them.
function node_bridge_post_body($content, $format, $notify, $email, $name)
{
    return array(
        'content' => (string)$content, 'format' => (string)$format, 'notify' => (bool)$notify,
        'email' => isset($email) ? (string)$email : null, 'name' => isset($name) ? (string)$name : null,
    );
}

// Sends a change to an existing post to Node. Returns Node's result, or stops with an error.
function node_bridge_change_post($method, $path, $body)
{
    header('X-Q2A-Post-Backend: node-api-v1');
    $result = node_bridge_api($method, $path, $body);
    if ($result['status'] >= 200 && $result['status'] < 300) return $result['data'];
    $code = $result['data']['error']['code'] ?? 'service_unavailable';
    qa_fatal_error('Node could not change the post: ' . $code . ' ' . json_encode($result['data']['error']['fields'] ?? array()));
}

// Favorites: the entity codes of app/updates.php as the API's URL names.
function node_bridge_favorite($entitytype, $entityid, $favorite)
{
    $types = array('Q' => 'questions', 'U' => 'users', 'T' => 'tags', 'C' => 'categories');
    if (!isset($types[$entitytype])) qa_fatal_error('Favorite type not recognized');
    header('X-Q2A-Favorite-Backend: node-api-v1');
    $result = node_bridge_api($favorite ? 'PUT' : 'DELETE', '/api/v1/favorites/' . $types[$entitytype] . '/' . (int)$entityid, new stdClass());
    if ($result['status'] < 200 || $result['status'] >= 300) {
        qa_fatal_error('Node could not change the favorite: ' . ($result['data']['error']['code'] ?? 'service_unavailable'));
    }
}

// The page passes the combined notify value (null, '@' or an address); Node takes the form's two fields.
function node_bridge_notify_fields($notify)
{
    if (!isset($notify)) return array('notify' => false, 'email' => '');
    return array('notify' => true, 'email' => $notify === '@' ? '' : (string)$notify);
}

function node_bridge_edit_body($content, $format, $notify, $name, $silent)
{
    $body = array('content' => (string)$content, 'format' => (string)$format, 'silent' => (bool)$silent) + node_bridge_notify_fields($notify);
    if (isset($name)) $body['name'] = (string)$name;
    return $body;
}
