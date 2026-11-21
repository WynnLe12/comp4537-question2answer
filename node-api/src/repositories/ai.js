function createAiRepository(pool) {
    return {
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
        }) {
            const connection = await pool.getConnection();

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
                        '/api/v1/ai/evaluate',
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
                connection.release();
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

        // Record AI requests that failed.
        async logFailedRequest(userId, statusCode) {
            await pool.execute(
                `INSERT INTO node_ai_usage
                (userid, evaluation_id, endpoint,
                status_code, tokens_used)
                VALUES (?, NULL, ?, ?, NULL)`,
                [
                    userId,
                    '/api/v1/ai/evaluate',
                    statusCode
                ]
            );
        }
    };
}

module.exports = { createAiRepository };
