
const request = require('supertest');
const { createApp } = require('../../src/app');
const { ApiError } = require('../../src/errors');

describe('AI REST API routes', () => {
    let app;
    let aiService;
    let identify;

    const testUser = {
        id: 1,
        handle: 'alice',
        email: 'alice@example.test',
        level: 0,
        flags: 0
    };

    const cookie = 'q2a_node_session=test-token';

    beforeEach(() => {
        aiService = {
            evaluate: jest.fn(),
            getHistory: jest.fn()
        };

        identify = jest.fn(async token => {
            if (token === 'test-token') {
                return testUser;
            }
            return null;
        });

        app = createApp({
            service: {},
            aiService,
            identify
        });
    });

    test('rejects unauthenticated evaluation requests', async () => {
        const response = await request(app)
            .post('/api/v1/ai/evaluate')
            .set('X-Q2A-Request', '1')
            .send({
                question: 'What is Node.js?',
                answer: 'A JavaScript runtime.'
            })
            .expect(401);

        expect(response.body).toEqual({
            error: { code: 'unauthenticated' }
        });

        expect(aiService.evaluate).not.toHaveBeenCalled();
    });

    test('rejects empty questions and answers', async () => {
        aiService.evaluate.mockRejectedValue(new ApiError(400, 'invalid_input'));

        const response = await request(app)
            .post('/api/v1/ai/evaluate')
            .set('Cookie', cookie)
            .set('X-Q2A-Request', '1')
            .send({
                question: '',
                answer: ''
            })
            .expect(400);

        expect(response.body).toEqual({
            error: { code: 'invalid_input' }
        });

        expect(aiService.evaluate).toHaveBeenCalledTimes(1);
    });

    test('evaluates an answer for an authenticated user', async () => {
        const evaluation = {
            evaluationId: 1,
            score: 85,
            feedback: 'The answer is mostly correct.',
            suggestions: ['Add more details.'],
            modelName: 'test-model',
            tokensUsed: 150
        };

        aiService.evaluate.mockResolvedValue(evaluation);

        const response = await request(app)
            .post('/api/v1/ai/evaluate')
            .set('Cookie', cookie)
            .set('X-Q2A-Request', '1')
            .send({
                question: 'What is Node.js?',
                answer: 'A JavaScript runtime.',
                questionId: 10,
                answerId: 20,
                userId: 999
            })
            .expect(200);

        expect(response.body).toEqual(evaluation);

        expect(aiService.evaluate).toHaveBeenCalledWith({
            identity: testUser,
            ip: '127.0.0.1',
            question: 'What is Node.js?',
            answer: 'A JavaScript runtime.',
            questionId: 10,
            answerId: 20
        });
    });

    test('retrieves evaluation history for the logged-in user', async () => {
        const history = [
            {
                evaluation_id: 1,
                score: 85,
                feedback: 'Mostly correct.'
            }
        ];

        aiService.getHistory.mockResolvedValue(history);

        const response = await request(app)
            .get('/api/v1/ai/evaluations')
            .set('Cookie', cookie)
            .expect(200);

        expect(response.body).toEqual({
            evaluations: history
        });

        expect(aiService.getHistory).toHaveBeenCalledWith(1);
    });

    test('limits excessive AI evaluation requests', async () => {
        aiService.evaluate.mockResolvedValue({
            evaluationId: 1,
            score: 85,
            feedback: 'Mostly correct.',
            suggestions: [],
            modelName: 'test-model',
            tokensUsed: 100
        });

        for (let i = 0; i < 10; i++) {
            await request(app)
                .post('/api/v1/ai/evaluate')
                .set('Cookie', cookie)
                .set('X-Q2A-Request', '1')
                .send({
                    question: 'What is Node.js?',
                    answer: 'A JavaScript runtime.'
                })
                .expect(200);
        }

        const response = await request(app)
            .post('/api/v1/ai/evaluate')
            .set('Cookie', cookie)
            .set('X-Q2A-Request', '1')
            .send({
                question: 'What is Node.js?',
                answer: 'A JavaScript runtime.'
            })
            .expect(429);

        expect(response.body).toEqual({
            error: {
                code: 'ai_rate_limit_exceeded'
            }
        });

        expect(aiService.evaluate).toHaveBeenCalledTimes(10);
    });
});
