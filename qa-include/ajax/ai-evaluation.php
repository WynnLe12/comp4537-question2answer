<?php

require_once QA_INCLUDE_DIR . 'app/users.php';
require_once QA_INCLUDE_DIR . 'app/format.php';
require_once QA_INCLUDE_DIR . 'db/selects.php';

header('Cache-Control: no-store');

/**
 * Resolve the visible answer and send its plain text to the Node API.
 */
function qa_ajax_ai_evaluation()
{
	if (!function_exists('node_bridge_api') || !qa_is_http_post()) {
		return array('error' => array('code' => 'unavailable'));
	}

	$userid = qa_get_logged_in_userid();
	if (!$userid) {
		return array('error' => array('code' => 'unauthenticated'));
	}

	if (!qa_check_form_security_code('ai-evaluation', qa_post_text('code'))) {
		return array('error' => array('code' => 'expired_form'));
	}

	$answerid = filter_var(qa_post_text('answerid'), FILTER_VALIDATE_INT, array('options' => array('min_range' => 1)));
	if (!$answerid) {
		return array('error' => array('code' => 'invalid_input'));
	}

	$answer = qa_db_select_with_pending(qa_db_full_post_selectspec($userid, $answerid));
	if (($answer['type'] ?? null) !== 'A') {
		return array('error' => array('code' => 'post_unavailable'));
	}

	$question = qa_db_select_with_pending(qa_db_full_post_selectspec($userid, $answer['parentid']));
	if (($question['type'] ?? null) !== 'Q' || qa_user_post_permit_error('permit_view_q_page', $question, null, false)) {
		return array('error' => array('code' => 'post_unavailable'));
	}

	$result = node_bridge_api('POST', '/api/v1/ai/evaluate', array(
		'questionId' => (int)$question['postid'],
		'answerId' => (int)$answer['postid'],
		'question' => trim($question['title'] . "\n\n" . qa_viewer_text($question['content'], $question['format'])),
		'answer' => trim(qa_viewer_text($answer['content'], $answer['format'])),
	), '', null, 40);

	return $result['data'] ?? array('error' => array('code' => 'unavailable'));
}

echo "QA_AJAX_RESPONSE\n" . json_encode(qa_ajax_ai_evaluation(), JSON_INVALID_UTF8_SUBSTITUTE);
