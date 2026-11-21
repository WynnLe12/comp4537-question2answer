CREATE TABLE IF NOT EXISTS node_ai_evaluations (
    evaluation_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    userid INT UNSIGNED NOT NULL,

    question_id INT UNSIGNED NULL,
    answer_id INT UNSIGNED NULL,

    question_text TEXT NOT NULL,
    answer_text TEXT NOT NULL,

    score TINYINT UNSIGNED NOT NULL,
    feedback TEXT NOT NULL,
    suggestions JSON NULL,

    model_name VARCHAR(100) NOT NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_ai_eval_user (userid),
    INDEX idx_ai_eval_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


CREATE TABLE IF NOT EXISTS node_ai_usage (
    usage_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,

    userid INT UNSIGNED NOT NULL,

    evaluation_id BIGINT UNSIGNED NULL,

    endpoint VARCHAR(150) NOT NULL,
    status_code SMALLINT UNSIGNED NOT NULL,

    tokens_used INT UNSIGNED NULL,

    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_ai_usage_user (userid),
    INDEX idx_ai_usage_created (created_at),

    CONSTRAINT fk_ai_usage_evaluation
        FOREIGN KEY (evaluation_id)
        REFERENCES node_ai_evaluations(evaluation_id)
        ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;