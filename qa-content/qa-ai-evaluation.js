(function () {
	'use strict';

	const messages = {
		unauthenticated: 'Your session has expired. Sign in again to use AI evaluation.',
		expired_form: 'Reload this page and try again.',
		invalid_input: 'The question or answer is empty or too long to evaluate.',
		post_unavailable: 'This question or answer is no longer available for evaluation.',
	};
	const unavailable = 'AI evaluation is temporarily unavailable. Please try again.';
	const rateLimitMessages = {
		ai_rate_limit_exceeded: 'Too many AI evaluations.',
		ai_provider_rate_limited: 'The AI provider is busy right now.',
	};

	function retrySeconds(value)
	{
		if (!value) {
			return null;
		}
		if (/^\d+$/.test(value)) {
			const seconds = Number(value);
			return Number.isSafeInteger(seconds) ? seconds : null;
		}
		const date = new Date(value);
		return Number.isFinite(date.getTime()) && date.toUTCString() === value
			? Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000)) : null;
	}

	function evaluationError(code, retryAfter)
	{
		if (!Object.hasOwn(rateLimitMessages, code)) {
			return Object.hasOwn(messages, code) ? messages[code] : unavailable;
		}
		const message = rateLimitMessages[code];
		const seconds = retrySeconds(retryAfter);
		if (seconds === null) {
			return message + ' Try again later.';
		}
		if (seconds === 0) {
			return message + ' You can try again now.';
		}
		const [divisor, unit] = seconds < 60 ? [1, 'second'] : seconds < 3600 ? [60, 'minute'] : [3600, 'hour'];
		const wait = Math.ceil(seconds / divisor);
		return message + ' Try again in ' + wait + ' ' + unit + (wait === 1 ? '.' : 's.');
	}

	function appendText(parent, tag, text)
	{
		const element = document.createElement(tag);
		element.textContent = text;
		parent.appendChild(element);
		return element;
	}

	function renderEvaluation(parent, evaluation)
	{
		appendText(parent, 'p', 'Estimated answer quality: ' + evaluation.score + '/100');
		appendText(parent, 'p', evaluation.feedback);

		if (evaluation.suggestions.length) {
			appendText(parent, 'strong', 'Suggestions');
			const list = document.createElement('ul');
			for (const suggestion of evaluation.suggestions) {
				appendText(list, 'li', suggestion);
			}
			parent.appendChild(list);
		}
	}

	document.addEventListener('click', async function (event) {
		const button = event.target.closest('.qa-ai-evaluation > button');
		if (!button || button.disabled) {
			return;
		}

		const panel = button.parentElement;
		const status = panel.querySelector('[role="status"]');
		const results = panel.querySelector('.qa-ai-results');
		button.disabled = true;
		status.textContent = 'Evaluating answer…';

		const params = new URLSearchParams({
			qa: 'ajax',
			qa_operation: 'ai_evaluation',
			qa_root: qa_root,
			qa_request: qa_request,
			answerid: panel.dataset.answerId,
			code: panel.dataset.code,
		});

		try {
			const response = await fetch(qa_root, {
				method: 'POST',
				credentials: 'same-origin',
				body: params,
			});
			const text = await response.text();
			const prefix = 'QA_AJAX_RESPONSE\n';
			if (!response.ok || !text.startsWith(prefix)) {
				throw new Error();
			}

			const data = JSON.parse(text.slice(prefix.length));
			if (data.error) {
				status.textContent = evaluationError(data.error.code, response.headers.get('Retry-After'));
				return;
			}

			const content = document.createDocumentFragment();
			renderEvaluation(content, data);
			const historyLink = appendText(content, 'a', 'View my AI history');
			historyLink.href = panel.dataset.historyUrl;
			results.replaceChildren(content);
			results.hidden = false;
			status.textContent = 'Evaluation saved.';
			button.querySelector('.qa-ai-button-label').textContent = 'Evaluate again';
		} catch {
			status.textContent = unavailable;
		} finally {
			button.disabled = false;
		}
	});
}());
