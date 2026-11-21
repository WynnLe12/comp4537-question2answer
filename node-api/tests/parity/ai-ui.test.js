const request = require('supertest');
const { runInNewContext } = require('node:vm');

const ui = process.env.MIGRATED_UI_URL || 'http://localhost:8081';
const prefix = 'QA_AJAX_RESPONSE\n';
let script;

beforeAll(async () => {
  script = (await request(ui).get('/qa-content/qa-ai-evaluation.js').expect(200)).text;
});

function evaluationUi(payload, retryAfter = null) {
  const element = () => ({
    textContent: '',
    children: [],
    appendChild(child) { this.children.push(child); },
  });
  const status = element();
  const label = element();
  const results = { hidden: true, replaceChildren(fragment) { this.children = fragment.children; } };
  const button = {
    disabled: false,
    parentElement: {
      dataset: { answerId: '2', code: 'form-code', historyUrl: '/?qa=ai-evaluation-history' },
      querySelector: selector => selector === '[role="status"]' ? status : results,
    },
    querySelector: () => label,
  };
  let onClick;
  const fetch = jest.fn().mockResolvedValue({
    ok: true,
    headers: { get: name => name === 'Retry-After' ? retryAfter : null },
    text: async () => prefix + JSON.stringify(payload),
  });
  runInNewContext(script, {
    document: {
      addEventListener: (_type, callback) => { onClick = callback; },
      createElement: element,
      createDocumentFragment: element,
    },
    fetch,
    URLSearchParams,
    Date: class extends Date { static now() { return Date.parse('Mon, 21 Oct 2030 07:27:00 GMT'); } },
    qa_root: '/',
    qa_request: '1',
  });
  const click = () => onClick({ target: { closest: () => button } });
  return { button, status, label, results, fetch, click };
}

test('renders a successful evaluation and sends only one request per in-flight click', async () => {
  const view = evaluationUi({ score: 86, feedback: 'Accurate <em>literal</em> feedback.', suggestions: ['Add an example.'] });
  const inFlight = view.click();
  await view.click();
  await inFlight;

  expect(view.fetch).toHaveBeenCalledTimes(1);
  expect(view.fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin' });
  expect(view.fetch.mock.calls[0][1].body.get('qa_operation')).toBe('ai_evaluation');
  expect(view.status.textContent).toBe('Evaluation saved.');
  expect(view.results.hidden).toBe(false);
  expect(view.results.children.map(child => child.textContent)).toEqual([
    'Estimated answer quality: 86/100', 'Accurate <em>literal</em> feedback.', 'Suggestions', '', 'View my AI history',
  ]);
  expect(view.results.children[3].children[0].textContent).toBe('Add an example.');
  expect(view.label.textContent).toBe('Evaluate again');
  expect(view.button.disabled).toBe(false);
});

test.each([
  ['ai_rate_limit_exceeded', '900', 'Too many AI evaluations. Try again in 15 minutes.'],
  ['ai_rate_limit_exceeded', null, 'Too many AI evaluations. Try again later.'],
  ['ai_provider_rate_limited', '37', 'The AI provider is busy right now. Try again in 37 seconds.'],
  ['ai_provider_rate_limited', 'Mon, 21 Oct 2030 07:28:00 GMT', 'The AI provider is busy right now. Try again in 1 minute.'],
  ['ai_provider_rate_limited', '0', 'The AI provider is busy right now. You can try again now.'],
  ['ai_provider_rate_limited', null, 'The AI provider is busy right now. Try again later.'],
  ['ai_provider_rate_limited', 'tomorrow', 'The AI provider is busy right now. Try again later.'],
  ['ai_provider_rate_limited', '9007199254740992', 'The AI provider is busy right now. Try again later.'],
  ['ai_provider_unavailable', '37', 'AI evaluation is temporarily unavailable. Please try again.'],
  ['unauthenticated', null, 'Your session has expired. Sign in again to use AI evaluation.'],
])('displays %s with Retry-After %s without retrying', async (code, retryAfter, expected) => {
  const view = evaluationUi({ error: { code, message: 'Private provider details' } }, retryAfter);
  await view.click();
  expect(view.status.textContent).toBe(expected);
  expect(view.fetch).toHaveBeenCalledTimes(1);
  expect(view.results.hidden).toBe(true);
  expect(view.button.disabled).toBe(false);
});

test('the PHP AJAX route keeps the prefixed error response for an unauthenticated request', async () => {
  const response = await request(ui).post('/').type('form').send({
    qa: 'ajax', qa_operation: 'ai_evaluation', qa_root: './', qa_request: '1', answerid: '2', code: 'invalid',
  }).expect(200);
  expect(response.text.startsWith(prefix)).toBe(true);
  expect(JSON.parse(response.text.slice(prefix.length))).toEqual({ error: { code: 'unauthenticated' } });
  expect(response.headers['retry-after']).toBeUndefined();
});
