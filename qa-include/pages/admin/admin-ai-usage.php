<?php

if (!function_exists('node_bridge_api')) {
	return include QA_INCLUDE_DIR . 'qa-page-not-found.php';
}

require_once QA_INCLUDE_DIR . 'app/admin.php';
require_once QA_INCLUDE_DIR . 'app/format.php';

header('Cache-Control: private, no-store');

if (!qa_admin_check_privileges($qa_content))
	return $qa_content;

$qa_content = qa_content_prepare();
$qa_content['title'] = qa_lang_html('admin/admin_title') . ' - AI Usage';

if (qa_get_logged_in_flags() & QA_USER_FLAGS_USER_BLOCKED) {
	$qa_content['error'] = qa_lang_html('admin/no_privileges');
	return $qa_content;
}

$qa_content['navigation']['sub'] = qa_admin_sub_navigation();
$qa_content['script_rel'][] = 'qa-content/qa-ai-usage.js?' . filemtime(QA_INCLUDE_DIR . '../qa-content/qa-ai-usage.js');
$qa_content['head_lines'][] = '<style>
	.qa-ai-usage-totals, .qa-ai-usage-tables {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
		gap: 1rem;
		margin-block: 0 1.25rem;
	}
	.qa-ai-usage-totals > div { border: 1px solid #c9d7e0; padding: 0.75rem; }
	.qa-ai-usage-totals dd { margin: 0.25rem 0 0; font-size: 1.5em; font-weight: bold; }
	.qa-ai-usage-tables table { width: 100%; border-collapse: collapse; }
	.qa-ai-usage-tables caption { text-align: left; font-weight: bold; padding-bottom: 0.45rem; }
	.qa-ai-usage-tables th, .qa-ai-usage-tables td {
		border-bottom: 1px solid #c9d7e0;
		padding: 0.45rem;
		text-align: left;
	}
	.qa-ai-usage-tables th:last-child, .qa-ai-usage-tables td:last-child {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.qa-ai-usage [role="status"]:empty { margin: 0; }
</style>';

$qa_content['custom'] = '<section class="qa-ai-usage" data-code="' . qa_html(qa_get_form_security_code('admin/ai-usage')) . '">
	<p role="status">Loading AI usage…</p>
	<div class="qa-ai-usage-data" aria-busy="true" hidden>
		<dl class="qa-ai-usage-totals">
			<div><dt>Total recorded AI requests</dt><dd data-total="totalRecordedRequests"></dd></div>
			<div><dt>Successful evaluations</dt><dd data-total="successfulEvaluations"></dd></div>
			<div><dt>Failed provider attempts</dt><dd data-total="failedProviderAttempts"></dd></div>
			<div><dt>Total recorded tokens</dt><dd data-total="totalRecordedTokens"></dd></div>
		</dl>
		<div class="qa-ai-usage-breakdowns" hidden>
			<div class="qa-ai-usage-tables">
				<table>
					<caption>Requests by date</caption>
					<thead><tr><th scope="col">Date</th><th scope="col">Requests</th></tr></thead>
					<tbody data-breakdown="byDate"></tbody>
				</table>
				<table>
					<caption>Requests by HTTP status</caption>
					<thead><tr><th scope="col">HTTP status</th><th scope="col">Requests</th></tr></thead>
					<tbody data-breakdown="byStatus"></tbody>
				</table>
			</div>
		</div>
	</div>
</section>';

return $qa_content;
