const { evaluateAnswer } = require('./aiProvider');
const { createAiRepository } = require('../repositories/ai');
const { ApiError } = require('../errors');
const { MAX_POSTID } = require('../http/request');
const { PERMIT, permitValueError } = require('../q2a/permissions');
const { createPostHelpers } = require('./post-common');

function requireEvaluationAccess(user) {
    if (!user) throw new ApiError(401, 'unauthenticated');
    if (permitValueError(PERMIT.USERS, user, user.level)) {
        throw new ApiError(403, 'no_permission');
    }
}

function createAiService(pool, postRepository) {
    const aiRepository = createAiRepository(pool);
    const { context, viewable, checkQuestionPage } = createPostHelpers({});

    async function validateLinkedPosts({ identity, ip, questionId, answerId }) {
        await postRepository.transaction(async q => {
            const ctx = await context(q, { identity, ip });
            requireEvaluationAccess(ctx.user);

            async function checkQuestion(id) {
                const question = await q.findPost(id);
                try {
                    checkQuestionPage(ctx, question);
                } catch (error) {
                    if (error instanceof ApiError && [403, 404].includes(error.status)) {
                        throw new ApiError(404, 'post_unavailable');
                    }
                    throw error;
                }
            }

            if (answerId === null) {
                await checkQuestion(questionId);
                return;
            }

            const answer = await q.findPost(answerId);
            if (answer?.basetype !== 'A' || !viewable(ctx, answer)) {
                throw new ApiError(404, 'post_unavailable');
            }
            // An answer is only accessible through a question the caller can view.
            await checkQuestion(answer.parentid);
            if (questionId !== null && questionId !== Number(answer.parentid)) {
                await checkQuestion(questionId);
                throw new ApiError(400, 'invalid_input');
            }
        });
    }

    return {
        // Evaluate an answer and save the result.
        async evaluate({
            identity,
            ip,
            question,
            answer,
            questionId = null,
            answerId = null
        }) {
            const userId = Number(identity?.id);
            if (!Number.isSafeInteger(userId) || userId <= 0) {
                throw new ApiError(401, 'unauthenticated');
            }
            requireEvaluationAccess(identity);

            // Validate the submitted question and answer.
            if (typeof question !== 'string' || typeof answer !== 'string' || !question.trim() || !answer.trim() || question.length > 5000 || answer.length > 10000) {
                throw new ApiError(400, 'invalid_input');
            }
            // Validate optional Q2A post IDs before calling OpenAI.
            for (const id of [questionId, answerId]) {
                if (id !== null && (!Number.isInteger(id) || id < 1 || id > MAX_POSTID)) {
                    throw new ApiError(400, 'invalid_input');
                }
            }
            if (questionId !== null || answerId !== null) {
                await validateLinkedPosts({ identity, ip, questionId, answerId });
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
