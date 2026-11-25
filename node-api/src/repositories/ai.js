const { ApiError } = require('../errors');

const EVALUATION_ENDPOINT = '/api/v1/ai/evaluate';
const ANSWER_LOCK = "SHA2(CONCAT(DATABASE(), ':q2a-ai-answer:', ?), 256)";

function createAiRepository(pool) {
    return {
        async getAnswerEvaluation({ questionId, answerId, question, answer }, db = pool) {
            const [[row]] = await db.execute(
                `SELECT evaluation_id AS evaluationId, score, feedback, suggestions, model_name AS modelName
                 FROM node_ai_evaluations
                 WHERE answer_id = ? AND question_id = ?
                   AND BINARY question_text = BINARY ? AND BINARY answer_text = BINARY ?
                 ORDER BY evaluation_id DESC
                 LIMIT 1`,
                [answerId, questionId, question, answer]
            );
            if (!row) return null;
            const suggestions = typeof row.suggestions === 'string' ? JSON.parse(row.suggestions) : row.suggestions;
            return { ...row, suggestions: suggestions ?? [] };
        },

        // Serialize cache misses across API instances using the same database.
        async withAnswerLock(answerId, work) {
            const connection = await pool.getConnection();
            let locked = false;
            try {
                const [[result]] = await connection.execute(`SELECT GET_LOCK(${ANSWER_LOCK}, 32) AS locked`, [answerId]);
                locked = result.locked === 1;
                if (!locked) throw new ApiError(503, 'evaluation_busy');
                return await work(connection);
            } finally {
                if (locked) {
                    try {
                        await connection.execute(`SELECT RELEASE_LOCK(${ANSWER_LOCK})`, [answerId]);
                    } catch (error) {
                        connection.destroy();
                        throw error;
                    }
                }
                connection.release();
            }
        },

        // Save a successful AI evaluation and usage record.
        async saveEvaluation({
            userId,
            questionId = null,
            answerId = null,
            question,
            answer,
            score,
            feedback,
            suggestions,
            modelName,
            tokensUsed
        }, lockedConnection) {
            const connection = lockedConnection ?? await pool.getConnection();

            try {
                await connection.beginTransaction();

                const [result] = await connection.execute(
                    `INSERT INTO node_ai_evaluations
           (userid, question_id, answer_id,
            question_text, answer_text, score,
            feedback, suggestions, model_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        userId,
                        questionId,
                        answerId,
                        question,
                        answer,
                        score,
                        feedback,
                        JSON.stringify(suggestions),
                        modelName
                    ]
                );

                const evaluationId = result.insertId;

                await connection.execute(
                    `INSERT INTO node_ai_usage
           (userid, evaluation_id, endpoint,
            status_code, tokens_used)
           VALUES (?, ?, ?, ?, ?)`,
                    [
                        userId,
                        evaluationId,
                        EVALUATION_ENDPOINT,
                        200,
                        tokensUsed ?? null
                    ]
                );

                await connection.commit();

                return evaluationId;
            } catch (error) {
                await connection.rollback();
                throw error;
            } finally {
                if (!lockedConnection) connection.release();
            }
        },

        // Retrieve evaluations belonging to one user.
        async getEvaluationsByUser(userId) {
            const [rows] = await pool.execute(
                `SELECT evaluation_id, question_id, answer_id,
                question_text, answer_text, score,
                feedback, suggestions, model_name,
                created_at
                FROM node_ai_evaluations
                WHERE userid = ?
                ORDER BY created_at DESC, evaluation_id DESC
                LIMIT 50`,
                [userId]
            );

            return rows.map(row => ({
                ...row,
                suggestions:
                    typeof row.suggestions === 'string'
                        ? JSON.parse(row.suggestions)
                        : row.suggestions
            }));
        },

        async getUserUsage(userId) {
            const [[usage]] = await pool.execute(
                `SELECT COUNT(*) AS totalRecordedRequests,
                        COALESCE(SUM(status_code = 200), 0) AS successfulEvaluations,
                        COALESCE(SUM(tokens_used), 0) AS totalRecordedTokens
                 FROM node_ai_usage
                 WHERE userid = ? AND endpoint = ?`,
                [userId, EVALUATION_ENDPOINT]
            );
            const totalRecordedRequests = Number(usage.totalRecordedRequests);
            const successfulEvaluations = Number(usage.successfulEvaluations);

            return {
                totalRecordedRequests,
                successfulEvaluations,
                failedProviderAttempts: totalRecordedRequests - successfulEvaluations,
                totalRecordedTokens: Number(usage.totalRecordedTokens)
            };
        },

        async getUsageStatistics() {
            const [rows] = await pool.execute(
                `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS usageDate, status_code AS statusCode,
                        COUNT(*) AS requestCount, COALESCE(SUM(tokens_used), 0) AS tokenCount
                 FROM node_ai_usage
                 WHERE endpoint = ?
                 GROUP BY usageDate, status_code
                 ORDER BY usageDate, status_code`,
                [EVALUATION_ENDPOINT]
            );

            let totalRecordedRequests = 0;
            let successfulEvaluations = 0;
            let totalRecordedTokens = 0;
            const byDate = new Map();
            const byStatus = new Map();
            for (const { usageDate, statusCode, requestCount, tokenCount } of rows) {
                const requests = Number(requestCount);
                totalRecordedRequests += requests;
                totalRecordedTokens += Number(tokenCount);
                // The outcome survives deletion of an evaluation and its foreign-key link.
                if (statusCode === 200) successfulEvaluations += requests;
                byDate.set(usageDate, (byDate.get(usageDate) ?? 0) + requests);
                byStatus.set(statusCode, (byStatus.get(statusCode) ?? 0) + requests);
            }

            return {
                totalRecordedRequests,
                successfulEvaluations,
                failedProviderAttempts: totalRecordedRequests - successfulEvaluations,
                totalRecordedTokens,
                byDate: Array.from(byDate, ([date, requests]) => ({ date, requests })),
                byStatus: Array.from(byStatus, ([statusCode, requests]) => ({ statusCode, requests }))
                    .sort((a, b) => a.statusCode - b.statusCode)
            };
        },

        // Record AI requests that failed.
        async logFailedRequest(userId, statusCode, db = pool) {
            await db.execute(
                `INSERT INTO node_ai_usage
                (userid, evaluation_id, endpoint,
                status_code, tokens_used)
                VALUES (?, NULL, ?, ?, NULL)`,
                [
                    userId,
                    EVALUATION_ENDPOINT,
                    statusCode
                ]
            );
        }
    };
}

module.exports = { createAiRepository };
