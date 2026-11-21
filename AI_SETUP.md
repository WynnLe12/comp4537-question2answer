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
- An OpenAI API key with available credits
- Node.js 24+ if running backend tests outside Docker

## Environment Configuration

Copy `.env.example` to `.env` in the project root.

Configure the following variables:

- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_MODEL`: AI model (default: gpt-4.1-mini)
- `CLIENT_ORIGINS`: Allowed frontend origins

Keep existing database and authentication variables.

Never commit `.env` or real API keys.

## Database Setup

From the repository root, start the Compose stack:

```powershell
docker compose up -d --build --wait
```

Compose waits for `node-db` to become healthy, then runs `seed-node`.
The seed prepares the Q2A schema and authentication tables and applies
[`001_ai_tables.sql`](node-api/migrations/001_ai_tables.sql) to create
`node_ai_evaluations` and `node_ai_usage`. The API starts after the seed
completes successfully.

Use the same command for a fresh setup or an existing Compose volume.
The migration uses `CREATE TABLE IF NOT EXISTS` and preserves existing
tables and rows. If initialization fails, inspect `docker compose logs seed-node`.

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

The evaluation endpoint limits authenticated requests to 10 per IP and 10
per Q2A account in a 15-minute window. Exceeding either limit returns
`429 ai_rate_limit_exceeded` with a `Retry-After` header. These limits
are per process. Counters reset on restart and each API instance tracks
its own counters.

## Provider Errors

Evaluation sends one provider request with a 30-second timeout.
The API returns errors as `{ "error": { "code": "..." } }`.

| HTTP status | Error code | Cause |
| --- | --- | --- |
| 429 | `ai_provider_rate_limited` | OpenAI returned 429. The API forwards a valid upstream `Retry-After` header when provided. |
| 502 | `ai_provider_unavailable` | Connection failure or an unexpected upstream HTTP error, such as 500 or 503. |
| 502 | `ai_provider_invalid_response` | Missing, incomplete, or malformed evaluation output. |
| 503 | `ai_provider_unavailable` | Missing OpenAI API key or upstream authentication or permission failure. |
| 504 | `ai_provider_timeout` | The request or response body exceeded the provider deadline. |

Successful evaluations record HTTP 200 and any reported total token count
in `node_ai_usage`. Failed provider attempts record the upstream HTTP
status when available for a non-success response, or the mapped API
status for timeouts, network failures, and malformed success responses.
Failed rows have no evaluation ID or token count. Local rejections and a
missing API key skip provider usage logging.

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
- Production cross-site cookie and CSRF configuration
  must be reviewed before public deployment.
- A third-party AI provider must be approved by the
  instructor or TA.
