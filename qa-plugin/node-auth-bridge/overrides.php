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
