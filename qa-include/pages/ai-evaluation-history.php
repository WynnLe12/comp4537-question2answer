<?php

if (!function_exists('node_bridge_api')) {
	return include QA_INCLUDE_DIR . 'qa-page-not-found.php';
}

header('Cache-Control: private, no-store');

if (!qa_is_logged_in()) {
	qa_redirect('login', array('to' => qa_path('ai-evaluation-history', null, '')));
}

$result = node_bridge_api('GET', '/api/v1/ai/evaluations');
$qa_content = qa_content_prepare();
$qa_content['title'] = 'AI Evaluation History';

$evaluations = $result['data']['evaluations'] ?? null;
if ($result['status'] !== 200 || !is_array($evaluations)) {
	$qa_content['error'] = 'AI evaluation history is temporarily unavailable. Please try again.';
	return $qa_content;
}

if (!$evaluations) {
	$qa_content['custom'] = '<p>You have no saved AI evaluations yet.</p>';
	return $qa_content;
}

$qa_content['custom'] = '';
foreach ($evaluations as $evaluation) {
	$title = explode("\n", $evaluation['question_text'], 2)[0];
	$qa_content['custom'] .= '<details style="margin-block: 0.75em; overflow-wrap: anywhere">'
		. '<summary>' . qa_html($title . ' · ' . $evaluation['score'] . '/100') . '</summary>'
		. '<p><strong>Evaluated answer</strong><br>' . qa_html($evaluation['answer_text'], true) . '</p>'
		. '<p><strong>AI feedback</strong><br>' . qa_html($evaluation['feedback'], true) . '</p>';

	if ($evaluation['suggestions']) {
		$qa_content['custom'] .= '<strong>Suggestions</strong><ul>';
		foreach ($evaluation['suggestions'] as $suggestion) {
			$qa_content['custom'] .= '<li>' . qa_html($suggestion) . '</li>';
		}
		$qa_content['custom'] .= '</ul>';
	}

	$qa_content['custom'] .= '</details>';
}

return $qa_content;
