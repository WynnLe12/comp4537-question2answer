const { AiProviderError, evaluateAnswer } = require('./aiProvider');
const { createAiRepository } = require('../repositories/ai');
const { ApiError } = require('../errors');
const { MAX_POSTID } = require('../http/request');
const { PERMIT, permitValueError } = require('../q2a/permissions');
const { viewerText } = require('../q2a/text');
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

    function validateId(id) {
        if (!Number.isInteger(id) || id < 1 || id > MAX_POSTID) {
            throw new ApiError(400, 'invalid_input');
        }
    }

    async function linkedPosts({ identity, ip, cookieid, questionId, answerId, generating }) {
        return postRepository.transaction(async q => {
            const ctx = await context(q, { identity, ip, cookieid });
            if (generating) requireEvaluationAccess(ctx.user);

            const answer = answerId === null ? null : await q.findPost(answerId);
            if (answerId !== null && (answer?.basetype !== 'A' || !viewable(ctx, answer))) {
                throw new ApiError(404, 'post_unavailable');
            }

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
                return question;
            }

            const question = await checkQuestion(answer?.parentid ?? questionId);
            if (answer && questionId !== null && questionId !== Number(question.postid)) {
                await checkQuestion(questionId);
                throw new ApiError(400, 'invalid_input');
            }

            return { question, answer };
        });
    }

    async function answerInput(request) {
        const { question, answer } = await linkedPosts(request);
        return {
            questionId: Number(question.postid),
            answerId: Number(answer.postid),
            question: (question.title + '\n\n' + viewerText(question.content ?? '', question.format ?? '')).trim(),
            answer: viewerText(answer.content ?? '', answer.format ?? '').trim()
        };
    }

    async function generate({ userId, questionId, answerId, question, answer }, connection) {
        let aiResult;

        try {
            // Call the OpenAI provider.
            aiResult = await evaluateAnswer(question, answer);
        } catch (error) {
            const failure = error instanceof AiProviderError
                ? error : new AiProviderError(502, 'ai_provider_unavailable');
            if (failure.attempted) {
                try {
                    await aiRepository.logFailedRequest(userId, failure.upstreamStatus ?? failure.status, connection);
                } catch {
                    console.error('Failed to record AI provider usage');
                }
            }
            throw failure;
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
        }, connection);

        // Return the result to the API route.
        return {
            evaluationId,
            score: aiResult.score,
            feedback: aiResult.feedback,
            suggestions: aiResult.suggestions,
            modelName: aiResult.modelName,
            tokensUsed: aiResult.tokensUsed
        };
    }

    return {
        async evaluate({ identity, ip, question, answer, questionId = null, answerId = null }) {
            const userId = Number(identity?.id);
            if (!Number.isSafeInteger(userId) || userId <= 0) {
                throw new ApiError(401, 'unauthenticated');
            }
            requireEvaluationAccess(identity);

            for (const id of [questionId, answerId]) {
                if (id !== null) validateId(id);
            }

            let input = { userId, questionId, answerId, question, answer };
            if (answerId !== null) {
                input = { userId, ...await answerInput({ identity, ip, questionId, answerId, generating: true }) };
            } else if (questionId !== null) {
                await linkedPosts({ identity, ip, questionId, answerId, generating: true });
            }

            if (typeof input.question !== 'string' || typeof input.answer !== 'string' ||
                !input.question.trim() || !input.answer.trim() || input.question.length > 5000 || input.answer.length > 10000) {
                throw new ApiError(400, 'invalid_input');
            }

            if (answerId === null) return generate(input);
            return aiRepository.withAnswerLock(answerId, async connection =>
                await aiRepository.getAnswerEvaluation(input, connection) ?? await generate(input, connection));
        },

        async getAnswerEvaluation({ identity, ip, cookieid, answerId }) {
            validateId(answerId);
            const input = await answerInput({ identity, ip, cookieid, answerId, questionId: null });
            return aiRepository.getAnswerEvaluation(input);
        },

        async getUsage(userId) {
            if (!Number.isSafeInteger(userId) || userId <= 0) {
                throw new ApiError(401, 'unauthenticated');
            }

            return aiRepository.getUserUsage(userId);
        },

        // Retrieve previous evaluations for a user.
        async getHistory(userId) {
            if (!Number.isSafeInteger(userId) || userId <= 0) {
                throw new ApiError(401, 'unauthenticated');
            }

            return aiRepository.getEvaluationsByUser(userId);
        }
    };
}

module.exports = { createAiService };
