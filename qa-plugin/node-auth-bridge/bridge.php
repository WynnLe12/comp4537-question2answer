<?php
if (!defined('QA_VERSION')) { http_response_code(404); exit; }

function node_bridge_valid_token($token)
{
    return is_string($token) && strlen($token) <= 2048 &&
        preg_match('/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/D', $token);
}

function node_bridge_request($action, $body = null)
{
    $token = $_COOKIE['q2a_node_bridge'] ?? '';
    $headers = "Accept: application/json\r\n";
    if (node_bridge_valid_token($token)) $headers .= "Cookie: q2a_node_session=" . $token . "\r\n";
    if ($body !== null) $headers .= "Content-Type: application/json\r\nX-Q2A-Request: 1\r\n";
    $context = stream_context_create(array('http' => array(
        'method' => $body === null ? 'GET' : 'POST', 'header' => $headers,
        'content' => $body === null ? '' : json_encode($body),
        'ignore_errors' => true, 'timeout' => 5, 'follow_location' => 0,
    )));
    $raw = @file_get_contents(rtrim(getenv('NODE_AUTH_API'), '/') . '/api/v1/auth/' . $action, false, $context);
    $status = 503;
    $cookie = null;
    foreach ($http_response_header ?? array() as $header) {
        if (preg_match('/^HTTP\/\S+ (\d+)/', $header, $match)) $status = (int)$match[1];
        if (preg_match('/^Set-Cookie: q2a_node_session=([^;]+);/i', $header, $match) && node_bridge_valid_token($match[1])) $cookie = $match[1];
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
