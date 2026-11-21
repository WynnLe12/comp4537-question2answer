const { evaluateAnswer } = require('./aiProvider');
const { createAiRepository } = require('../repositories/ai');

function createAiService(pool) {
    const aiRepository = createAiRepository(pool);

    return {
        // Evaluate an answer and save the result.
        async evaluate({
            userId,
            question,
            answer,
            questionId = null,
            answerId = null
        }) {
            // Validate the authenticated user.
            if (!Number.isSafeInteger(userId) || userId <= 0) {
                const error = new Error('Authentication required');
                error.statusCode = 401;
                throw error;
            }

            // Validate the submitted question and answer.
            if (typeof question !== 'string' || typeof answer !== 'string' || !question.trim() || !answer.trim() || question.length > 5000 || answer.length > 10000) {
                const error = new Error('Invalid question or answer');
                error.statusCode = 400;
                throw error;
            }
            // Validate optional Q2A post IDs before calling OpenAI.
            for (const id of [questionId, answerId]) {
                if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) {
                    const error = new Error('Invalid question or answer ID');
                    error.statusCode = 400;
                    throw error;
                }
            }
            let aiResult;

            try {
                // Call the OpenAI provider.
                aiResult = await evaluateAnswer(question, answer);
            } catch (error) {
                // Log an unsuccessful AI request.
                const statusCode = 502;

                try {
                    await aiRepository.logFailedRequest(
                        userId,
                        statusCode
                    );
                } catch (logError) {
                    console.error(
                        'Failed to log AI API usage:',
                        logError.message
                    );
                }

                const serviceError = new Error('AI evaluation is temporarily unavailable');
                serviceError.statusCode = statusCode;
                throw serviceError;
            }

            // Save the evaluation and usage data in MySQL.
            const evaluationId = await aiRepository.saveEvaluation({
                userId,
                questionId,
                answerId,
                question,
                answer,
                score: aiResult.score,
                feedback: aiResult.feedback,
                suggestions: aiResult.suggestions,
                modelName: aiResult.modelName,
                tokensUsed: aiResult.tokensUsed
            });

            // Return the result to the API route.
            return {
                evaluationId,
                score: aiResult.score,
                feedback: aiResult.feedback,
                suggestions: aiResult.suggestions,
                modelName: aiResult.modelName,
                tokensUsed: aiResult.tokensUsed
            };
        },

        // Retrieve previous evaluations for a user.
        async getHistory(userId) {
            if (!Number.isSafeInteger(userId) || userId <= 0) {
                const error = new Error('Authentication required');
                error.statusCode = 401;
                throw error;
            }

            return aiRepository.getEvaluationsByUser(userId);
        }
    };
}

module.exports = { createAiService };
