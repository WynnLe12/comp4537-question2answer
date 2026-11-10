# Authentication migration: developer implementation guide

This guide explains the code added for the first Q2A PHP → Node.js migration slice: registration, login, session lookup, and logout. It is a map for developers changing the implementation. For startup commands and a presentation script, see [MIGRATION_README.md](MIGRATION_README.md); for the supported Q2A settings and known differences, see [docs/auth-migration.md](docs/auth-migration.md).

## Boundary and request flow

Q2A's original `qa-include/pages/login.php` and `register.php` controllers still render the browser forms with the same `qa-theme/` CSS and `qa-content/` assets. There is **no new frontend**. Only the authentication decision and its database writes move to Node. The bridge exists because those PHP forms submit to PHP controllers; they do not call a REST API themselves.

```text
Browser ── GET /?qa=login ────────────────> PHP Q2A page + existing theme/CSS
Browser ── POST form + Q2A CSRF code ───> PHP bridge (port 8081)
                                            │ check CSRF; map form fields
                                            └── JSON POST /api/v1/auth/login ──> Node API
                                                                                 └── node-db
Browser <── original Q2A redirect/form ─── PHP bridge <── JSON + session cookie
Browser ── next page + bridge cookie ────> PHP bridge ── GET /me ─────────────> Node API
```

`php` on port 8080 runs the unmodified PHP reference against `php-db`. `migrated-ui` on port 8081 runs the **same PHP image and frontend files** against `node-db`, with the bridge enabled. `api` on port 3000 uses `node-db` too. The two databases let tests submit equivalent operations without one side changing the other's records. The Node API is authoritative for authentication on port 8081; PHP still renders pages and runs other Q2A features.

## File map

| File | Responsibility |
| --- | --- |
| [`compose.yaml`](compose.yaml) | Starts the reference PHP site, migrated UI, Node API, two isolated MySQL databases, seed jobs, and test container. |
| [`docker/php/Dockerfile`](docker/php/Dockerfile) | Builds PHP 8.3/Apache with `mysqli` and `mbstring`, copying the original Q2A source. |
| [`docker/php/qa-config.php`](docker/php/qa-config.php) | Supplies local Docker database settings to Q2A from environment variables. |
| [`docker/php/seed.php`](docker/php/seed.php) | Runs Q2A's own installer, sets the supported local profile, creates `alice`/`legacy`, and adds the Node session table. |
| [`node-api/Dockerfile`](node-api/Dockerfile) | Builds the Node 24 API image and installs locked dependencies. |
| [`node-api/package.json`](node-api/package.json), `package-lock.json` | Defines dependencies and API/parity test commands. |
| [`node-api/src/db.js`](node-api/src/db.js) | Builds the `mysql2` connection pool from `DB_*` variables. |
| [`node-api/src/server.js`](node-api/src/server.js) | Checks database/profile compatibility, assembles layers, starts port 3000, and closes cleanly. |
| [`node-api/src/app.js`](node-api/src/app.js) | Configures Express, JSON limits, headers, health check, versioned routes, and safe errors. |
| [`node-api/src/routes/v1/auth.js`](node-api/src/routes/v1/auth.js) | Defines HTTP contract, request guard, rate limit, and Node cookie. |
| [`node-api/src/services/auth.js`](node-api/src/services/auth.js) | Recreates supported Q2A input/password rules and the four auth operations. |
| [`node-api/src/repositories/users.js`](node-api/src/repositories/users.js) | Reads/writes Q2A tables and Node sessions, including registration transactions. |
| [`qa-plugin/node-auth-bridge/qa-plugin.php`](qa-plugin/node-auth-bridge/qa-plugin.php) | Enables Q2A function overrides only when `NODE_AUTH_API` is set. |
| [`qa-plugin/node-auth-bridge/overrides.php`](qa-plugin/node-auth-bridge/overrides.php) | Intercepts the original auth forms and checks Node identity for Q2A pages. |
| [`qa-plugin/node-auth-bridge/bridge.php`](qa-plugin/node-auth-bridge/bridge.php) | Performs PHP-to-Node HTTP requests, bridge-cookie handling, and form error mapping. |
| [`node-api/tests/integration/auth.test.js`](node-api/tests/integration/auth.test.js) | Tests API contracts/security with an in-memory repository. |
| [`node-api/tests/parity/auth.test.js`](node-api/tests/parity/auth.test.js) | Compares real original-PHP form outcomes and Node JSON/database outcomes. |
| [`node-api/tests/parity/shared-ui.test.js`](node-api/tests/parity/shared-ui.test.js) | Checks shared CSS/form structure and end-to-end bridge sessions. |
| [`docs/node-auth-workflow.yml`](docs/node-auth-workflow.yml) | GitHub Actions template for contract and Docker parity suites; install under `.github/workflows/` to activate CI. |

The upstream `qa-include/` controllers and frontend assets are reference code, not migrated files. `MIGRATION_README.md` is the run/demo guide; `docs/auth-migration.md` records scope and parity limits. `.dockerignore` and `.gitignore` keep build context and generated files out of Docker/Git.

## Docker setup and data ownership

The key Compose switch is `NODE_AUTH_API`. Both UI containers use the same PHP build; only the migrated one receives this variable and points at the Node database:

```yaml
# Excerpt from compose.yaml
php:
  <<: *php
  ports: ["127.0.0.1:8080:80"]

migrated-ui:
  <<: *php
  environment:
    <<: *credentials
    DB_HOST: node-db
    NODE_AUTH_API: http://api:3000
  ports: ["127.0.0.1:8081:80"]
```

`seed-php` and `seed-node` invoke Q2A's own `qa_db_install_tables()` and `qa_create_new_user()`, so the starting schema and fixtures come from PHP rather than a hand-copied schema. The seed adds one migration-specific table:

```sql
CREATE TABLE IF NOT EXISTS node_auth_sessions (
    token_hash CHAR(64) CHARACTER SET ascii PRIMARY KEY,
    userid INT UNSIGNED NOT NULL,
    expires_at DATETIME NOT NULL,
    KEY expires_at (expires_at)
) ENGINE=InnoDB;
```

`qa_users`, `qa_userpoints`, and `qa_options` remain Q2A tables. The two Compose volumes persist separately. The seed's local `site_url` is `http://localhost:8080/`, so a public deployment needs a suitable host URL/configuration; this Docker profile is for local development.

## From the original form to the Node API

The plugin registers Q2A function overrides only in `migrated-ui`:

```php
// qa-plugin/node-auth-bridge/qa-plugin.php
if (getenv('NODE_AUTH_API')) {
    require_once __DIR__ . '/bridge.php';
    qa_register_plugin_overrides('overrides.php');
}
```

The browser submits `emailhandle`, `password`, `remember`, `dologin`, and `code` to the existing PHP login page; registration similarly submits `handle`, `email`, `password`, `doregister`, and `code`. `overrides.php` checks the **original Q2A CSRF code**, collects those fields, then removes the submit marker before calling the original controller to render a response. Removing it prevents the original PHP authentication write from also running:

```php
// Condensed from qa-plugin/node-auth-bridge/overrides.php
$valid = qa_check_form_security_code($action, qa_post_text('code'));
$input = $action === 'login'
    ? array('emailhandle' => (string)qa_post_text('emailhandle'),
            'password' => (string)qa_post_text('password'),
            'remember' => (bool)qa_post_text('remember'))
    : array('handle' => (string)qa_post_text('handle'),
            'email' => (string)qa_post_text('email'),
            'password' => (string)qa_post_text('password'));
unset($_POST['do' . $action]);
unset($_POST['password']);
if (!$valid) { /* render original form with Q2A CSRF error */ }
$result = node_bridge_request($action, $input);
```

The PHP-to-Node call happens **server to server**. A browser network trace therefore shows the existing form POST to port 8081, not a separate browser `fetch()` to port 3000. The bridge sends JSON plus the API's required custom header, and forwards the Node session token as a cookie on later calls:

```php
// Condensed from qa-plugin/node-auth-bridge/bridge.php
if (node_bridge_valid_token($token))
    $headers .= "Cookie: q2a_node_session=" . $token . "\r\n";
if ($body !== null)
    $headers .= "Content-Type: application/json\r\nX-Q2A-Request: 1\r\n";
$raw = @file_get_contents(
    rtrim(getenv('NODE_AUTH_API'), '/') . '/api/v1/auth/' . $action,
    false,
    $context
);
```

On success, the bridge copies the returned token into its own `q2a_node_bridge` HttpOnly, SameSite=Strict cookie scoped to `/`, then redirects using Q2A's original page flow. On failure, `node_bridge_errors()` puts API errors into the original Q2A form and restores non-password field values. Auth submissions include `X-Q2A-Auth-Backend: node-api-v1` in their HTTP response, making the active backend visible in browser developer tools. There is no fallback to PHP password verification if Node is unavailable.

For every subsequent Q2A page, the override asks Node who owns the bridge token instead of trusting PHP's login cookie. The bridge checks only the JWT's compact shape before forwarding it; cryptographic verification belongs to Node:

```php
// qa-plugin/node-auth-bridge/overrides.php
function qa_get_logged_in_userid()
{
    static $checked = false;
    static $id = null;
    if (!$checked) {
        $checked = true;
        if (!empty($_COOKIE['q2a_node_bridge'])) {
            $result = node_bridge_request('me');
            if ($result['status'] === 200) $id = $result['data']['user']['id'];
        }
    }
    return $id;
}
```

The static values avoid repeated `/me` calls during one PHP request. Logout calls Node's `/logout`, revokes the session row, clears the bridge cookie, and redirects. If Node cannot confirm logout, the bridge displays an error instead of pretending the session was revoked.

## Node layers and v1 contract

`server.js` assembles `db → repository → service → app`; it reads `qa_options` and refuses to start if unsupported authentication settings are enabled. This prevents a misleading parity claim if, for example, CAPTCHA or confirmation is turned on in PHP while Node lacks those flows. `app.js` mounts only `/api/v1/auth`; unversioned and `/api/v2/...` paths return 404. Compatible changes stay in v1, while breaking API contracts would require v2.

```js
// node-api/src/server.js (excerpt)
const pool = createPool();
await pool.query('SELECT 1');
// Check the expected Q2A authentication options before serving requests.
const service = createAuthService(createUserRepository(pool), {
  jwtSecret: process.env.AUTH_JWT_SECRET,
});
const app = createApp({
  service,
  health: () => pool.query('SELECT 1'),
  secureCookies: process.env.NODE_ENV === 'production',
});
```

| Method | Path | Success |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | 201, public user JSON, session cookie |
| POST | `/api/v1/auth/login` | 200, public user JSON, session cookie |
| GET | `/api/v1/auth/me` | 200, public user JSON |
| POST | `/api/v1/auth/logout` | 204, session revoked |

POSTs require JSON and `X-Q2A-Request: 1`; the original PHP form CSRF check happens before the bridge sends them. No CORS origins are enabled. `auth.js` applies a shared in-memory login/registration rate limiter, returns `Cache-Control: no-store`, and sets the API's `q2a_node_session` cookie as HttpOnly and SameSite=Strict (`Secure` when `NODE_ENV=production`). The API cookie is scoped to `/api/v1/auth`; the bridge cookie is scoped to `/` so the existing Q2A pages can receive it. `app.js` also uses Helmet, limits JSON bodies to 16 KB, and maps internal failures to a generic 503 without leaking SQL details.

```js
// node-api/src/routes/v1/auth.js (excerpt)
router.post('/login', limiter, async (req, res) =>
  establish(res, await service.login(req.body || {}, req.ip), 200));
router.post('/register', limiter, async (req, res) =>
  establish(res, await service.register(req.body || {}, req.ip), 201));
router.get('/me', async (req, res) =>
  res.json({ user: await service.me(readToken(req)) }));
router.post('/logout', async (req, res) => {
  await service.logout(readToken(req));
  res.clearCookie(cookieName, cookieOptions).status(204).end();
});
```

The service returns only `id`, `handle`, `email`, `level`, and `flags`, never password hashes or tokens in JSON. It mirrors the supported PHP input behavior: ASCII whitespace trimming and newline normalization, handle cleanup, 20-character handle limit, 80-character email limit, and an eight-character password minimum. An invalid login and an unknown account share the public `invalid_credentials` error. `remember: true` sets a 30-day server session; other sessions expire after one day.

```js
// node-api/src/services/auth.js (excerpt)
function postText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new AuthError(400, 'invalid_input');
  return value
    .replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '')
    .replace(/\r\n?/g, '\n');
}

const token = jwt.sign({}, jwtSecret, {
  algorithm: 'HS256', issuer: 'q2a-node-api', audience: 'q2a-auth',
  subject: String(user.userid), jwtid: randomBytes(16).toString('hex'), expiresIn: ttl,
});
await repository.createSession(user.userid, tokenHash(token), ttl, ip);
```

`me()` verifies the HS256 signature, issuer, audience, expiry, numeric user ID,
and random token ID before querying the stored digest. It also checks that the
database user matches the JWT subject. A valid signature alone is insufficient:
logout removes the digest, and the next `/me` returns 401. The JWT travels in
HttpOnly cookies, not a browser bearer header or localStorage.

`verifyPassword()` accepts Q2A's bcrypt hashes and its older salted SHA-1 `passsalt`/`passcheck` format. A successful legacy login (or an outdated bcrypt cost) replaces the stored password with bcrypt cost 10 and clears the legacy fields:

```js
// node-api/src/services/auth.js (excerpt)
const actual = createHash('sha1')
  .update(salt.slice(0, 8) + password + salt.slice(8)).digest();
legacyValid = expected.length === actual.length && timingSafeEqual(expected, actual);
const modernValid = user.passhash ? await bcrypt.compare(password, user.passhash) : false;
return {
  valid: legacyValid || modernValid,
  rehash: legacyValid || (modernValid && bcrypt.getRounds(user.passhash) !== 10),
};
```

The repository uses parameterized MySQL values and Q2A's existing tables. Registration takes a MySQL advisory lock because Q2A's handle/email indexes are not unique; inside a transaction it checks duplicates, inserts `qa_users`, initializes `qa_userpoints` to 100, updates cached counts in `qa_options`, then commits. A failure rolls everything back. The service verifies the JWT signature, algorithm, issuer, audience, and expiry before looking it up. A Node session stores only the **SHA-256 digest** of the signed JWT, not the raw bearer token, so logout can revoke it immediately:

```js
// node-api/src/repositories/users.js (selected statements)
await connection.query("SELECT GET_LOCK('node_auth_register', 10) AS acquired");
await connection.beginTransaction();
await connection.execute(
  'INSERT INTO qa_userpoints (userid,points) VALUES (?,100)',
  [result.insertId]
);
await connection.commit();

// During session creation:
await connection.execute(
  'INSERT INTO node_auth_sessions (token_hash,userid,expires_at) ' +
  'VALUES (?,?,TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP()))',
  [hash, id, ttl]
);
```

`findSession()` joins `node_auth_sessions` to `qa_users` and requires `expires_at > UTC_TIMESTAMP()`; `deleteSession()` removes that digest on logout. The Compose secret is local-only; a production host must provide its own `AUTH_JWT_SECRET` of at least 32 bytes. Old opaque sessions require a new login after this change. The advisory lock serializes **Node** registrations. This milestone does not support concurrent original-PHP and Node registration into one shared database.

## How parity is checked

Two suites serve different purposes. `npm test` uses Jest and Supertest with a replaceable in-memory repository, so it quickly checks response codes, cookie flags, JWT claims, tampered/expired/wrong-audience tokens, logout revocation, invalid/oversized JSON, rate limiting, hidden errors, versioning, and password/input compatibility. `npm run test:parity` needs the Docker stack: it sends real form POSTs to the PHP reference and JSON requests to Node against separately seeded MySQL databases.

```js
// Condensed from node-api/tests/parity/auth.test.js
const form = await client.get(`/?qa=${page}`).expect(200);
const $ = cheerio.load(form.text);
const code = $(`[name=do${page}]`).closest('form').find('input[name=code]').val();
const php = await client.post(`/?qa=${page}`).type('form')
  .send({ ...input, code, [`do${page}`]: '1' });

const node = await client.post(`/api/v1/auth/${page}`)
  .set('X-Q2A-Request', '1').send(input);
// Compare acceptance/authenticated state and records, not HTML against JSON.
```

The parity cases cover successful and failed registration/login, duplicate fields, invalid inputs, login by handle/email/case/trimmed input, logout, legacy password upgrade, equivalent user/points records, cached counts, concurrent Node duplicate registration, rollback after a points-write failure, and expired/remembered sessions. Password hashes are verified against the password instead of compared byte for byte because their salts vary.

The shared-UI suite fetches both login forms and compares input names, then fetches the linked theme stylesheet from each site and compares CSS bytes. It also submits the original form on port 8081, checks the `X-Q2A-Auth-Backend` response header, confirms a Node session row, and tests persistence/revocation, wrong passwords, and invalid CSRF codes:

```js
// Condensed from node-api/tests/parity/shared-ui.test.js
expect(fields(migrated)).toEqual(fields(original));
expect(cssFromMigratedSite.text).toBe(cssFromOriginalSite.text);
expect(registerResponse.headers['x-q2a-auth-backend']).toBe('node-api-v1');
```

Run locally from the repository root:

```sh
docker compose up --build -d --wait
docker compose run --rm --no-deps tests npm test
docker compose run --build --rm tests
```

The last command runs the parity suite. The workflow template can run both suites on push and pull request once installed under `.github/workflows/`. Tests create synthetic users in the two **development** databases. The code currently checks identical CSS content and form structure, not pixel-perfect screenshots across browsers or every Q2A page. Authentication is the only migrated feature in this slice.
