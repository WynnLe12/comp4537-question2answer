<?php

if (QA_FINAL_EXTERNAL_USERS || !function_exists('node_bridge_api')) {
	return include QA_INCLUDE_DIR . 'qa-page-not-found.php';
}

header('Cache-Control: private, no-store');

if (!qa_is_logged_in()) {
	qa_redirect('login', array('to' => qa_path('ai-usage', null, '')));
}

$qa_content = qa_content_prepare();
$qa_content['title'] = 'My AI API Usage';
$qa_content['navigation']['sub'] = qa_user_sub_navigation(qa_get_logged_in_handle(), 'ai-usage', true);

$usage = node_bridge_api('GET', '/api/v1/ai/usage');
if ($usage['status'] !== 200 || !is_array($usage['data'])) {
	$qa_content['error'] = 'AI API usage is temporarily unavailable.';
	return $qa_content;
}

$labels = array(
	'totalRecordedRequests' => 'Recorded requests',
	'successfulEvaluations' => 'Successful evaluations',
	'failedProviderAttempts' => 'Failed provider attempts',
	'totalRecordedTokens' => 'Recorded tokens',
);

$qa_content['form'] = array('style' => 'wide', 'fields' => array());
foreach ($labels as $key => $label) {
	$qa_content['form']['fields'][] = array(
		'type' => 'static',
		'label' => $label,
		'value' => number_format($usage['data'][$key]),
	);
}

return $qa_content;
