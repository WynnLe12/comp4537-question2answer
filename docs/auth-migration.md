# Authentication migration

The Node API lives in `node-api/`; upstream PHP remains unchanged. Reference:
`bc1a8bc4fa951da908f14fc15aef65b01e8027a4` (Q2A 1.8.8).

## Run locally

Start Docker Desktop, then from the repository root:

```sh
cp .env.example .env # First setup only; preserve an existing .env
docker compose up --build -d
docker compose ps
```

- PHP reference: http://localhost:8080/?qa=login
- Node health: http://localhost:3000/health
- Migrated authentication UI: http://localhost:8081/?qa=login (same Q2A frontend files).
- Synthetic account: `alice` / `Password123!` (`alice@example.test`).
- A second `legacy` account exercises old password upgrades.

See [the migration README](../MIGRATION_README.md) for the UI demo script and code map.

Compose runs PHP 8.3/Apache, Node 24, and two MySQL 8.4 services with separate
persistent volumes. Seed jobs use Q2A's original installer and account functions.
Existing accounts are not overwritten; the development profile is reapplied on
startup. Credentials are local-only, web ports bind to loopback, and MySQL ports
are not published. `docker compose down` retains data. For a deliberate reset of
these synthetic databases only, `docker compose down -v` removes the volumes.

## v1 contract

| Method and path | Body | Success |
| --- | --- | --- |
| POST `/api/v1/auth/register` | `handle`, `email`, `password` | 201, user and session cookie |
| POST `/api/v1/auth/login` | `emailhandle`, `password`, optional boolean `remember` | 200, user and session cookie |
| GET `/api/v1/auth/me` | None | 200, authenticated user |
| POST `/api/v1/auth/logout` | `{}` | 204, session revoked |

POST requires JSON and `X-Q2A-Request: 1`. Cookies are HttpOnly and SameSite=Strict;
production mode adds Secure. No CORS origins are enabled. Responses expose only
the signed-in user's id, handle, email, level, and flags. Errors contain
`error.code` and optional `error.fields`: invalid input 400, invalid credentials
or unauthenticated 401, duplicate registration 409, unavailable dependencies 503.
The cookie contains an HS256-signed JWT with issuer, audience, subject, random ID,
and expiry. `AUTH_JWT_SECRET` must be at least 32 bytes and must be supplied as
a private runtime environment variable. Compose reads it from the root `.env`,
along with `BCRYPT_SALT_ROUNDS` (default `10`, integer from 4 to 31). The latter
controls new password hashes, rehash checks, and password upgrades. Changing the
JWT secret invalidates existing sessions. Commit only `.env.example`, not `.env`.
The API stores only a SHA-256 digest of the JWT in `node_auth_sessions`; `/me`
requires both a valid signature and a live database row. Logout deletes that row.
The browser sends the HttpOnly cookie automatically; there is no bearer-header
or localStorage flow in this slice. The PHP reference uses its original session
system, so its cookies are not interchangeable with Node's.

```sh
curl -i -c /tmp/q2a-cookies.txt http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' -H 'X-Q2A-Request: 1' \
  -d '{"emailhandle":"alice","password":"Password123!"}'
curl -b /tmp/q2a-cookies.txt http://localhost:3000/api/v1/auth/me
curl -i -b /tmp/q2a-cookies.txt http://localhost:3000/api/v1/auth/logout \
  -H 'Content-Type: application/json' -H 'X-Q2A-Request: 1' -d '{}'
```

Compatible additions/fixes stay in v1; breaking public contracts introduce v2.
PHP is the reference implementation, not API v1.

## Test

```sh
cd node-api
npm ci
npm test
cd ..
docker compose run --build --rm tests
```

The first suite tests HTTP/security contracts and password/input compatibility
without MySQL, including JWT claims, tampering, expiry, audience, and revocation.
The parity suite uses real PHP forms (including their own CSRF
tokens and cookies), Node JSON endpoints, and both databases. It compares accepted
and rejected actions, authentication, user/points state, and password upgrades.
Random salted hashes are verified rather than compared byte-for-byte. Additional
Node tests cover concurrent duplicate registrations. Test runs create uniquely
named synthetic users and reset the legacy fixture password for its upgrade test.
Use only these development databases. The inactive GitHub Actions template in
[`node-auth-workflow.yml`](node-auth-workflow.yml) runs both suites and uploads
test reports and service logs once installed under `.github/workflows/`.

## Supported profile and differences

This first slice supports built-in username/email authentication, standard `qa_`
tables, eight-character minimum passwords, 20-character handles, 80-character
emails, and 100 initial points. CAPTCHA, terms, email confirmation, custom fields,
registration suspension, and external/plugin authentication are disabled. The API
assumes this profile without validating Q2A options at startup; changing those
settings does not change the Node authentication behavior.

Source rules: `qa-include/pages/login.php`, `pages/register.php`,
`app/users-edit.php`, `plugins/qa-filter-basic.php`, and `db/users.php`.
Preserved behaviors include PHP form trimming (including passwords), handle
cleanup, MySQL-collation duplicate checks, auto-login on registration, user/points
and cached count creation, bcrypt verification, and salted-SHA-1 password upgrades.

Intentional changes and remaining scope:

- JSON replaces forms/redirects. Unknown-user and wrong-password errors are identical
  in the API to reduce account enumeration.
- API sessions use signed JWTs with random token IDs. The JWT is checked for its
  signature, HS256 algorithm, issuer, audience, and expiry; its SHA-256 digest is
  stored in `node_auth_sessions` for immediate revocation and server-side expiry.
  They do not share PHP cookies. Normal sessions last one day; remembered sessions
  last 30 days. Existing opaque Node sessions become invalid on this change and
  require login again. PHP backup-cookie and concurrent-session behavior is not reproduced.
- JSON-only POSTs and a custom request header replace PHP's form CSRF mechanism.
  The shared-frontend bridge additionally checks Q2A's original CSRF token before
  forwarding forms to Node. It is enabled only in the `migrated-ui` service; PHP
  still renders the pages, and Node verifies identity on each request. Non-auth
  features visible on that site remain PHP. The bridge redirects successful
  authentication to the home page rather than preserving the optional `to` query.
- The local profile allows 1,000 attempts/hour. Node combines login/registration
  attempts in an in-memory limiter; PHP uses separate counters and counts successful
  registrations differently. Exact rate-limit parity/distributed limiting is deferred.
- User/points/count creation is transactional. An advisory lock serializes Node
  registrations because Q2A's email/handle indexes are not unique. Concurrent PHP
  and Node writes to one shared database are unsupported.
- Welcome mail, confirmation, custom fields, event plugins, password reset, IP
  blocking, and broader permission flows are deferred. PHP may attempt welcome
  mail, but the container has no mail delivery.
- Email validation uses `validator` with ASCII local parts. Tested cases match PHP;
  exhaustive equivalence to `FILTER_VALIDATE_EMAIL` is not claimed.
- This is a development demonstration, not a production deployment configuration.

The repository license applies to migrated logic; attribution is retained in code.
