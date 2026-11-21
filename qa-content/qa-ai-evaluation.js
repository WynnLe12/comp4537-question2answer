(function () {
	'use strict';

	const messages = {
		unauthenticated: 'Your session has expired. Sign in again to use AI evaluation.',
		expired_form: 'Reload this page and try again.',
		invalid_input: 'The question or answer is empty or too long to evaluate.',
		post_unavailable: 'This question or answer is no longer available for evaluation.',
		ai_rate_limit_exceeded: 'Too many evaluations. Try again in a few minutes.',
	};

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
				throw new Error(data.error.code);
			}

			const content = document.createDocumentFragment();
			renderEvaluation(content, data);
			const historyLink = appendText(content, 'a', 'View my AI history');
			historyLink.href = panel.dataset.historyUrl;
			results.replaceChildren(content);
			results.hidden = false;
			status.textContent = 'Evaluation saved.';
			button.querySelector('.qa-ai-button-label').textContent = 'Evaluate again';
		} catch (error) {
			status.textContent = Object.hasOwn(messages, error.message)
				? messages[error.message]
				: 'AI evaluation is temporarily unavailable. Please try again.';
		} finally {
			button.disabled = false;
		}
	});
}());
