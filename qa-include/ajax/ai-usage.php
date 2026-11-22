<?php

header('Cache-Control: private, no-store');

function qa_ajax_ai_usage()
{
	if (!function_exists('node_bridge_api') || !qa_is_http_post())
		return array('error' => array('code' => 'unavailable'));

	if (!qa_is_logged_in())
		return array('error' => array('code' => 'unauthenticated'));

	if (qa_get_logged_in_level() < QA_USER_LEVEL_ADMIN || (qa_get_logged_in_flags() & QA_USER_FLAGS_USER_BLOCKED))
		return array('error' => array('code' => 'no_privileges'));

	if (!qa_check_form_security_code('admin/ai-usage', qa_post_text('code')))
		return array('error' => array('code' => 'expired_form'));

	$result = node_bridge_api('GET', '/api/v1/admin/ai/usage');
	if ($result['status'] === 200 && is_array($result['data']))
		return $result['data'];

	$code = $result['status'] === 401 ? 'unauthenticated' : ($result['status'] === 403 ? 'no_privileges' : 'unavailable');
	return array('error' => array('code' => $code));
}

echo "QA_AJAX_RESPONSE\n" . json_encode(qa_ajax_ai_usage(), JSON_INVALID_UTF8_SUBSTITUTE);
