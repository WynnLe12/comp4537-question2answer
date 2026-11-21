# AI Answer Evaluation — Setup Guide

## Overview

This feature adds AI-powered answer evaluation to the
Question2Answer Node.js backend.

Authenticated users can submit questions and answers to
receive an AI-generated quality score, feedback, and
suggestions for improvement.

The backend also saves evaluations and tracks API usage
in MySQL.

## Requirements

- Docker Desktop
- Node.js 24+
- An OpenAI API key with available credits
- Existing Q2A MySQL database

## Environment Configuration

Copy `.env.example` to `.env` in the project root.

Configure the following variables:

- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_MODEL`: AI model (default: gpt-4.1-mini)
- `CLIENT_ORIGINS`: Allowed frontend origins

Keep existing database and authentication variables.

Never commit `.env` or real API keys.

## Database Setup

Start the project's Docker containers:

```powershell
docker compose up -d --build
```

Copy the migration file into the Node.js MySQL container:

```powershell
docker compose cp node-api/migrations/001_ai_tables.sql node-db:/tmp/001_ai_tables.sql
```

Execute the migration:

```powershell
docker compose exec -T node-db sh -c 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" < /tmp/001_ai_tables.sql'
```

This creates:

- `node_ai_evaluations`
- `node_ai_usage`

The migration uses `CREATE TABLE IF NOT EXISTS`, so it
can be rerun without recreating existing tables.

## REST API Endpoints

### POST /api/v1/ai/evaluate

Requires an authenticated Q2A user.

Request:

```json
{
  "question": "What is Node.js?",
  "answer": "Node.js runs JavaScript outside the browser."
}
```

Successful response:

```json
{
  "evaluationId": 1,
  "score": 70,
  "feedback": "The answer is accurate but incomplete.",
  "suggestions": [
    "Explain common use cases."
  ],
  "modelName": "gpt-4.1-mini-2025-04-14",
  "tokensUsed": 351
}
```

### GET /api/v1/ai/evaluations

Returns up to 50 saved evaluations belonging to the
authenticated user.

## Authentication

Both endpoints require a valid Q2A API session.

For browser requests:

- Include credentials.
- Use the `X-Q2A-Request: 1` header.
- Configure the frontend origin in `CLIENT_ORIGINS`.

## Rate Limiting

The evaluation endpoint currently allows 10 requests
per IP address every 15 minutes.

Excessive requests return HTTP 429.

## Testing

Run the backend test suite:

```powershell
docker compose exec api npm test
```

The AI tests use mocked provider responses and do not
consume OpenAI API credits.

## Important Notes

- AI scores are estimates of answer quality, not
  guaranteed probabilities of correctness.
- The backend stores evaluations and API usage separately.
- The frontend and API must be deployed on different origins.
- Production cross-site cookie and CSRF configuration
  must be reviewed before public deployment.
- A third-party AI provider must be approved by the
  instructor or TA.
```

### 3. Save and stage the documentation

Run:

```powershell
git add node-api/AI_SETUP.md
```

Then verify:

```powershell
git diff --cached --check
```

If there's no output, the documentation is staged without whitespace errors.

### What remains before pushing?

Your implementation and tests are in good shape. We still need to inspect the staged code for secrets, confirm the SQL migration and application wiring are safe, and review deployment authentication settings.

**For now, create `AI_SETUP.md` and stage it.** Send me **"next"** when finished, and we'll review the staged changes before committing your work.