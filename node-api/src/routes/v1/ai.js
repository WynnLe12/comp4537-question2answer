const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp } = require('../../http/request');
const { ApiError } = require('../../errors');
const { rateLimit } = require('express-rate-limit');

function aiRoutes({ aiService, identify }) {
    const router = Router();

    // Limit AI requests to protect paid API credits.
    const aiLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: {
            error: {
                code: 'ai_rate_limit_exceeded'
            }
        }
    });

    router.use(requireApiRequest);

    // Require an authenticated Q2A user for all AI routes.
    router.use(async (req, res, next) => {
        try {
            const token = readToken(req);
            const user = await identify(token);

            if (!user) {
                throw new ApiError(401, 'unauthenticated');
            }

            req.aiUser = user;
            next();
        } catch (error) {
            next(error);
        }
    });

    // POST /api/v1/ai/evaluate
    router.post('/evaluate', aiLimiter, async (req, res, next) => {
        try {
            const { question, answer, questionId = null, answerId = null } = req.body || {};

            const result = await aiService.evaluate({
                identity: req.aiUser,
                ip: clientIp(req.ip),
                question,
                answer,
                questionId,
                answerId
            });

            res.status(200).json(result);
        } catch (error) {
            next(normalizeAiError(error));
        }
    });

    // GET /api/v1/ai/evaluations
    router.get('/evaluations', async (req, res, next) => {
        try {
            const evaluations = await aiService.getHistory(Number(req.aiUser.id));

            res.json({ evaluations });
        } catch (error) {
            next(normalizeAiError(error));
        }
    });

    return router;
}

// Convert AI service errors to Balpreet's API error format.
function normalizeAiError(error) {
    if (error instanceof ApiError) {
        return error;
    }

    if (error.statusCode === 400) {
        return new ApiError(400, 'invalid_input');
    }

    if (error.statusCode === 401) {
        return new ApiError(401, 'unauthenticated');
    }

    if (error.statusCode === 502) {
        return new ApiError(502, 'ai_provider_unavailable');
    }

    return error;
}

module.exports = { aiRoutes };
