const { createAiService } = require('../../src/services/ai');

// Mock OpenAI so tests do not spend API credits.
jest.mock('../../src/services/aiProvider', () => ({
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

    beforeEach(() => {
        jest.clearAllMocks();

        repository = {
            saveEvaluation: jest.fn().mockResolvedValue(1),
            getEvaluationsByUser: jest.fn().mockResolvedValue([]),
            logFailedRequest: jest.fn().mockResolvedValue()
        };

        createAiRepository.mockReturnValue(repository);

        aiService = createAiService({});
    });

    test('evaluates an answer and saves the result', async () => {
        evaluateAnswer.mockResolvedValue({
            score: 85,
            feedback: 'The answer is mostly correct.',
            suggestions: ['Add more details.'],
            modelName: 'test-model',
            tokensUsed: 150
        });

        const result = await aiService.evaluate({
            userId: 1,
            question: 'What is Node.js?',
            answer: 'A JavaScript runtime.'
        });

        expect(result.score).toBe(85);
        expect(result.evaluationId).toBe(1);
        expect(result.feedback).toBe(
            'The answer is mostly correct.'
        );

        expect(evaluateAnswer).toHaveBeenCalledTimes(1);

        expect(repository.saveEvaluation).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 1,
                score: 85,
                tokensUsed: 150
            })
        );
    });

    test('rejects unauthenticated users', async () => {
        await expect(
            aiService.evaluate({
                userId: null,
                question: 'What is Node.js?',
                answer: 'A JavaScript runtime.'
            })
        ).rejects.toMatchObject({
            statusCode: 401
        });

        expect(evaluateAnswer).not.toHaveBeenCalled();
        expect(repository.saveEvaluation).not.toHaveBeenCalled();
    });

    test('rejects invalid input', async () => {
        await expect(
            aiService.evaluate({
                userId: 1,
                question: '',
                answer: ''
            })
        ).rejects.toMatchObject({
            statusCode: 400
        });

        expect(evaluateAnswer).not.toHaveBeenCalled();
    });

    test('rejects invalid post IDs before calling OpenAI', async () => {
        await expect(
            aiService.evaluate({
                userId: 1,
                question: 'What is Node.js?',
                answer: 'A JavaScript runtime.',
                questionId: 'invalid',
                answerId: -5
            })
        ).rejects.toMatchObject({
            statusCode: 400
        });

        expect(evaluateAnswer).not.toHaveBeenCalled();
        expect(repository.saveEvaluation).not.toHaveBeenCalled();
    });

    test('handles AI provider failures', async () => {
        evaluateAnswer.mockRejectedValue(
            new Error('OpenAI unavailable')
        );

        await expect(
            aiService.evaluate({
                userId: 1,
                question: 'What is Node.js?',
                answer: 'A JavaScript runtime.'
            })
        ).rejects.toMatchObject({
            statusCode: 502,
            message: 'AI evaluation is temporarily unavailable'
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
