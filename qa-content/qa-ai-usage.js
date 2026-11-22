(function () {
	'use strict';

	const isCount = value => Number.isSafeInteger(value) && value >= 0;
	const format = new Intl.NumberFormat();
	const errors = {
		unauthenticated: 'Your session has expired. Sign in again to view AI usage.',
		no_privileges: 'Only administrators may view AI usage.',
		expired_form: 'Reload this page to view AI usage.',
	};
	const unavailable = 'AI usage is temporarily unavailable. Reload this page to try again.';

	function fillTable(table, rows, key)
	{
		for (const row of rows) {
			const tr = table.insertRow();
			tr.insertCell().textContent = row[key];
			tr.insertCell().textContent = format.format(row.requests);
		}
	}

	document.addEventListener('DOMContentLoaded', async function () {
		const dashboard = document.querySelector('.qa-ai-usage');
		if (!dashboard)
			return;

		const notice = dashboard.querySelector('[role="status"]');
		const data = dashboard.querySelector('.qa-ai-usage-data');
		const totals = [...data.querySelectorAll('[data-total]')];

		try {
			const response = await fetch(qa_root, {
				method: 'POST',
				credentials: 'same-origin',
				body: new URLSearchParams({
					qa: 'ajax', qa_operation: 'ai_usage', qa_root, qa_request, code: dashboard.dataset.code,
				}),
			});
			const prefix = 'QA_AJAX_RESPONSE\n';
			const text = await response.text();
			if (!response.ok || !text.startsWith(prefix))
				throw new Error();

			const usage = JSON.parse(text.slice(prefix.length));
			if (usage.error) {
				notice.textContent = Object.hasOwn(errors, usage.error.code) ? errors[usage.error.code] : unavailable;
				return;
			}
			if (!totals.every(cell => isCount(usage[cell.dataset.total])) ||
				!Array.isArray(usage.byDate) || !usage.byDate.every(row => typeof row?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && isCount(row.requests)) ||
				!Array.isArray(usage.byStatus) || !usage.byStatus.every(row => isCount(row?.statusCode) && isCount(row.requests))) {
				throw new Error();
			}

			for (const cell of totals)
				cell.textContent = format.format(usage[cell.dataset.total]);

			fillTable(data.querySelector('[data-breakdown="byDate"]'), usage.byDate, 'date');
			fillTable(data.querySelector('[data-breakdown="byStatus"]'), usage.byStatus, 'statusCode');
			const empty = usage.totalRecordedRequests === 0;
			data.querySelector('.qa-ai-usage-breakdowns').hidden = empty;
			notice.textContent = empty ? 'No AI requests have been recorded yet.' : '';
			data.hidden = false;
		} catch {
			notice.textContent = unavailable;
		} finally {
			data.setAttribute('aria-busy', 'false');
		}
	});
}());
