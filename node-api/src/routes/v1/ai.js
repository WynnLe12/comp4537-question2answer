const { Router } = require('express');
const { readToken, requireApiRequest } = require('../../http/cookies');
const { clientIp, postIdParam, readVisitorCookie } = require('../../http/request');
const { ApiError } = require('../../errors');
const { rateLimit } = require('express-rate-limit');
const { AiProviderError } = require('../../services/aiProvider');

function aiRoutes({ aiService, identify }) {
    const router = Router();

    // Each limiter uses a separate in-memory store.
    const limiterOptions = {
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: 'draft-8',
        legacyHeaders: false,
        message: {
            error: {
                code: 'ai_rate_limit_exceeded'
            }
        }
    };
    const ipLimiter = rateLimit({ ...limiterOptions, identifier: 'ai-ip' });
    const userLimiter = rateLimit({
        ...limiterOptions,
        identifier: 'ai-user',
        keyGenerator: req => String(req.aiUser.id)
    });

    router.use(requireApiRequest);

    router.get('/answers/:answerId/evaluation', async (req, res) => {
        const token = readToken(req);
        const evaluation = await aiService.getAnswerEvaluation({
            identity: token ? await identify(token) : null,
            ip: clientIp(req.ip),
            cookieid: readVisitorCookie(req),
            answerId: postIdParam(req.params.answerId)
        });
        res.json({ evaluation });
    });

    // Generation, personal history and usage require a signed-in user.
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
    router.post('/evaluate', (req, res, next) => {
        res.append('Access-Control-Expose-Headers', 'Retry-After, RateLimit, RateLimit-Policy');
        next();
    }, ipLimiter, userLimiter, async (req, res) => {
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
            if (!(error instanceof AiProviderError)) throw error;
            if (error.retryAfter !== undefined) res.set('Retry-After', error.retryAfter);
            res.status(error.status).json({ error: { code: error.code } });
        }
    });

    // GET /api/v1/ai/evaluations
    router.get('/evaluations', async (req, res) => {
        const evaluations = await aiService.getHistory(Number(req.aiUser.id));
        res.json({ evaluations });
    });

    router.get('/usage', async (req, res) => {
        res.json(await aiService.getUsage(Number(req.aiUser.id)));
    });

    return router;
}

module.exports = { aiRoutes };
