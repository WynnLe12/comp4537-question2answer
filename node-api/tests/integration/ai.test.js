const { createAiService } = require('../../src/services/ai');
const { FLAGS, LEVEL, PERMIT } = require('../../src/q2a/permissions');

// Mock OpenAI so tests do not spend API credits.
jest.mock('../../src/services/aiProvider', () => ({
    ...jest.requireActual('../../src/services/aiProvider'),
    evaluateAnswer: jest.fn()
}));

// Mock database operations.
jest.mock('../../src/repositories/ai', () => ({
    createAiRepository: jest.fn()
}));

const { evaluateAnswer } = require('../../src/services/aiProvider');
const { createAiRepository } = require('../../src/repositories/ai');

describe('AI answer evaluation service', () => {
    let aiService;
    let repository;
    let postRepository;
    let queries;
    let posts;
    let options;

    const identity = { id: 1, level: LEVEL.BASIC, flags: 0 };
    const input = {
        identity,
        question: 'What is Node.js?',
        answer: 'A JavaScript runtime.'
    };
    const result = {
        score: 85,
        feedback: 'The answer is mostly correct.',
        suggestions: ['Add more details.'],
        modelName: 'test-model',
        tokensUsed: 150
    };

    async function expectRejection(overrides, status, code) {
        await expect(aiService.evaluate({ ...input, ...overrides })).rejects.toMatchObject({ status, code });
        expect(evaluateAnswer).not.toHaveBeenCalled();
        expect(repository.saveEvaluation).not.toHaveBeenCalled();
        expect(repository.logFailedRequest).not.toHaveBeenCalled();
    }

    beforeEach(() => {
        jest.clearAllMocks();

        repository = {
            saveEvaluation: jest.fn().mockResolvedValue(1),
            getEvaluationsByUser: jest.fn().mockResolvedValue([]),
            logFailedRequest: jest.fn().mockResolvedValue()
        };

        createAiRepository.mockReturnValue(repository);

        posts = new Map([
            [10, { postid: 10, basetype: 'Q', userid: 2 }],
            [11, { postid: 11, basetype: 'Q', userid: 2 }],
            [20, { postid: 20, basetype: 'A', parentid: 10, userid: 2 }],
            [30, { postid: 30, basetype: 'C', parentid: 20, userid: 2 }]
        ]);
        options = new Map([
            ['permit_view_q_page', PERMIT.ALL],
            ['permit_hide_show', PERMIT.EDITORS],
            ['permit_moderate', PERMIT.EXPERTS]
        ]);
        queries = {
            loadOptions: jest.fn().mockResolvedValue(options),
            setMaxStoreUserUpdates: jest.fn(),
            findActor: jest.fn().mockResolvedValue({ ...identity, userid: identity.id, categoryLevels: new Map() }),
            findPost: jest.fn(async id => posts.get(id))
        };
        postRepository = { transaction: jest.fn(work => work(queries)) };
        aiService = createAiService({}, postRepository);
    });

    test('evaluates an answer and saves the result', async () => {
        evaluateAnswer.mockResolvedValue(result);
        const response = await aiService.evaluate(input);

        expect(response.score).toBe(85);
        expect(response.evaluationId).toBe(1);
        expect(response.feedback).toBe(
            'The answer is mostly correct.'
        );

        expect(evaluateAnswer).toHaveBeenCalledTimes(1);
        expect(postRepository.transaction).not.toHaveBeenCalled();

        expect(repository.saveEvaluation).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 1,
                score: 85,
                tokensUsed: 150
            })
        );
    });

    test('rejects unauthenticated users', async () => {
        await expectRejection({ identity: null }, 401, 'unauthenticated');
    });

    test('rejects invalid input', async () => {
        await expectRejection({ question: '', answer: '' }, 400, 'invalid_input');
    });

    test('rejects blocked users even without linked posts', async () => {
        await expectRejection({ identity: { ...identity, flags: FLAGS.USER_BLOCKED } }, 403, 'no_permission');
        expect(postRepository.transaction).not.toHaveBeenCalled();
    });

    test('honors a block applied after the session was resolved', async () => {
        queries.findActor.mockResolvedValue({ userid: 1, flags: FLAGS.USER_BLOCKED });
        await expectRejection({ questionId: 10 }, 403, 'no_permission');
        expect(queries.findPost).not.toHaveBeenCalled();
    });

    test.each([
        { questionId: '10' }, { answerId: -5 }, { questionId: 0 },
        { answerId: 12.5 }, { questionId: 4294967296 }, { answerId: 4294967296 }
    ])('rejects an invalid post ID in %j before looking up any posts', async ids => {
        await expectRejection(ids, 400, 'invalid_input');
        expect(postRepository.transaction).not.toHaveBeenCalled();
    });

    test.each([
        { questionId: 999 }, { answerId: 999 },
        { questionId: 20 }, { answerId: 10 }, { answerId: 30 }
    ])('returns a generic error for a missing or wrong-type post in %j', async ids => {
        await expectRejection(ids, 404, 'post_unavailable');
    });

    test('rejects an answer linked to another viewable question', async () => {
        await expectRejection({ questionId: 11, answerId: 20 }, 400, 'invalid_input');
    });

    test.each([
        [10, 'hidden'], [20, 'hidden'], [20, 'queued']
    ])('does not disclose an inaccessible post %i with state %s', async (id, state) => {
        posts.get(id)[state] = 1;
        await expectRejection({ questionId: 10, answerId: 20 }, 404, 'post_unavailable');
    });

    test('checks the actual parent of an answer even when a different question is supplied', async () => {
        posts.get(10).hidden = 1;
        await expectRejection({ questionId: 11, answerId: 20 }, 404, 'post_unavailable');
        await expectRejection({ answerId: 20 }, 404, 'post_unavailable');
    });

    test('rejects an answer whose parent question cannot be found', async () => {
        posts.delete(10);
        await expectRejection({ answerId: 20 }, 404, 'post_unavailable');
    });

    test('honors question-page access settings', async () => {
        options.set('permit_view_q_page', PERMIT.EDITORS);
        await expectRejection({ answerId: 20 }, 404, 'post_unavailable');
    });

    test.each([
        { questionId: 10, answerId: 20 }, { questionId: 10 }, { answerId: 20 }
    ])('evaluates and preserves valid linked IDs in %j', async ids => {
        evaluateAnswer.mockResolvedValue(result);
        await expect(aiService.evaluate({ ...input, ...ids })).resolves.toEqual({ ...result, evaluationId: 1 });
        expect(evaluateAnswer).toHaveBeenCalledWith(input.question, input.answer);
        expect(repository.saveEvaluation).toHaveBeenCalledWith(expect.objectContaining({
            userId: 1, questionId: null, answerId: null, ...ids
        }));
        expect(queries.findPost).toHaveBeenCalledWith(10);
    });

    test('honors category permissions and post ownership when applying visibility rules', async () => {
        options.set('permit_view_q_page', PERMIT.EDITORS);
        Object.assign(posts.get(10), { categoryids: '7', hidden: 1 });
        Object.assign(posts.get(20), { userid: 1, queued: 1 });
        queries.findActor.mockResolvedValue({
            userid: 1, level: LEVEL.BASIC, flags: 0, categoryLevels: new Map([[7, LEVEL.EDITOR]])
        });
        evaluateAnswer.mockResolvedValue(result);
        await expect(aiService.evaluate({ ...input, answerId: 20 })).resolves.toHaveProperty('evaluationId', 1);
    });

    test('accepts the largest MySQL post ID', async () => {
        const questionId = 4294967295;
        posts.set(questionId, { postid: questionId, basetype: 'Q', userid: 2 });
        evaluateAnswer.mockResolvedValue(result);
        await expect(aiService.evaluate({ ...input, questionId })).resolves.toHaveProperty('evaluationId', 1);
    });

    test('handles AI provider failures', async () => {
        evaluateAnswer.mockRejectedValue(
            new Error('OpenAI unavailable')
        );

        await expect(
            aiService.evaluate(input)
        ).rejects.toMatchObject({
            status: 502,
            code: 'ai_provider_unavailable',
            message: 'ai_provider_unavailable'
        });

        expect(repository.logFailedRequest)
            .toHaveBeenCalledWith(1, 502);

        expect(repository.saveEvaluation).not.toHaveBeenCalled();
    });

    test('retrieves only the requested user history', async () => {
        const history = [{
            evaluation_id: 1,
            score: 85
        }];

        repository.getEvaluationsByUser.mockResolvedValue(history);

        const result = await aiService.getHistory(1);

        expect(result).toEqual(history);

        expect(repository.getEvaluationsByUser)
            .toHaveBeenCalledWith(1);
    });
});
