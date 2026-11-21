const request = require('supertest');
const { createApp } = require('../../src/app');
const { createAiService } = require('../../src/services/ai');

const providerBody = (output = JSON.stringify({ score: 85, feedback: 'Accurate.', suggestions: ['Add an example.'] })) => ({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }],
  model: 'test-model',
  usage: { total_tokens: 42 },
});

describe('AI evaluation with the provider transport mocked', () => {
  let app;
  let fetchMock;
  let pool;
  let connection;
  let previousKey;

  beforeEach(() => {
    previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-only-api-key';
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
    connection = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(), release: jest.fn(),
      execute: jest.fn().mockResolvedValue([{ insertId: 21 }]),
    };
    pool = {
      execute: jest.fn().mockResolvedValue([]),
      getConnection: jest.fn().mockResolvedValue(connection),
    };
    app = createApp({
      service: {},
      aiService: createAiService(pool),
      identify: async token => ({ id: Number(token), flags: 0, level: 0 }),
      trustProxy: 'loopback',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  });

  const endpoint = '/api/v1/ai/evaluate';
  const evaluate = (user = 1, ip = '192.0.2.1') => request(app).post(endpoint)
    .set('Cookie', `q2a_node_session=${user}`)
    .set('X-Forwarded-For', ip)
    .set('X-Q2A-Request', '1')
    .send({ question: 'What is Node.js?', answer: 'A runtime.' });

  async function expectProviderFailure(status, code, usageStatus = status) {
    const response = await evaluate().expect(status);
    expect(response.body).toEqual({ error: { code } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pool.getConnection).not.toHaveBeenCalled();
    expect(pool.execute).toHaveBeenCalledTimes(1);
    expect(pool.execute).toHaveBeenCalledWith(expect.stringContaining('VALUES (?, NULL, ?, ?, NULL)'), [1, endpoint, usageStatus]);
    return response;
  }

  test('preserves the evaluation response and records tokens on success', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(providerBody()));
    const response = await evaluate().expect(200);
    expect(response.body).toEqual({
      evaluationId: 21, score: 85, feedback: 'Accurate.', suggestions: ['Add an example.'],
      modelName: 'test-model', tokensUsed: 42,
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/responses', expect.objectContaining({
      method: 'POST', redirect: 'error', signal: expect.any(AbortSignal),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(connection.execute).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO node_ai_usage'), [1, 21, endpoint, 200, 42]);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(pool.execute).not.toHaveBeenCalled();
  });

  test.each(['connection', 'response body'])('times out during the %s', async phase => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    function expire() {
      controller.abort(new DOMException('Private timeout details', 'TimeoutError'));
      throw controller.signal.reason;
    }
    fetchMock.mockImplementationOnce(async () => phase === 'connection' ? expire() : { ok: true, json: async () => expire() });
    await expectProviderFailure(504, 'ai_provider_timeout');
    expect(timeout).toHaveBeenCalledWith(30000);
  });

  test.each([
    ['45', '45'],
    ['Wed, 21 Oct 2030 07:28:00 GMT', undefined],
    ['Mon, 21 Oct 2030 07:28:00 GMT', 'Mon, 21 Oct 2030 07:28:00 GMT'],
    ['private-provider-value', undefined],
    [undefined, undefined],
  ])('forwards only a valid Retry-After from an upstream HTTP 429 (%s)', async (header, expected) => {
    const upstream = Response.json({ error: { message: 'Private provider details' } }, {
      status: 429,
      headers: header === undefined ? {} : { 'Retry-After': header },
    });
    const readBody = jest.spyOn(upstream, 'json');
    fetchMock.mockResolvedValueOnce(upstream);
    const response = await expectProviderFailure(429, 'ai_provider_rate_limited');
    expect(response.headers['retry-after']).toBe(expected);
    expect(readBody).not.toHaveBeenCalled();
  });

  test.each([[401, 503], [403, 503], [500, 502], [503, 502]])(
    'retains provider HTTP %i for usage and responds with HTTP %i', async (upstream, status) => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: { message: 'Private provider details' } }, { status: upstream }));
      await expectProviderFailure(status, 'ai_provider_unavailable', upstream);
    }
  );

  test('rejects missing configuration before attempting a provider call', async () => {
    process.env.OPENAI_API_KEY = ' ';
    const response = await evaluate().expect(503);
    expect(response.body).toEqual({ error: { code: 'ai_provider_unavailable' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pool.execute).not.toHaveBeenCalled();
    expect(pool.getConnection).not.toHaveBeenCalled();
  });

  test('preserves a sanitized network error even if the failed usage write also fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Sensitive network details'));
    pool.execute.mockRejectedValueOnce(new Error('Private database details'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expectProviderFailure(502, 'ai_provider_unavailable');
    expect(log.mock.calls).toEqual([['Failed to record AI provider usage']]);
  });

  test.each([
    ['invalid HTTP response JSON', () => new Response('private non-JSON provider response')],
    ['incomplete output', () => Response.json({ ...providerBody(), status: 'incomplete' })],
    ['invalid evaluation JSON', () => Response.json(providerBody('private non-JSON evaluation'))],
    ['malformed message', () => Response.json({ ...providerBody(), output: {} })],
    ['invalid score', () => Response.json(providerBody('{"score":101,"feedback":"Test","suggestions":[]}'))],
  ])('rejects %s before creating an evaluation', async (_name, response) => {
    fetchMock.mockResolvedValueOnce(response());
    await expectProviderFailure(502, 'ai_provider_invalid_response');
  });

  test.each(['IP', 'account'])('enforces the %s limit independently', async limit => {
    fetchMock.mockImplementation(async () => Response.json(providerBody()));
    const send = index => limit === 'IP' ? evaluate(index) : evaluate(1, `192.0.2.${index}`);
    for (let index = 1; index <= 10; index++) await send(index).expect(200);
    const response = await send(11).expect(429);
    expect(response.body).toEqual({ error: { code: 'ai_rate_limit_exceeded' } });
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect(response.headers['ratelimit']).toContain(limit === 'IP' ? 'ai-ip' : 'ai-user');
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(pool.getConnection).toHaveBeenCalledTimes(10);
    expect(pool.execute).not.toHaveBeenCalled();
  });
});
