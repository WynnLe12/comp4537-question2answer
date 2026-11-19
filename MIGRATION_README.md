# Q2A → Node.js migration

This fork explores whether AI-assisted development can reproduce selected Q2A
backend using Node.js REST APIs, one feature at a time, with the original PHP application as
the reference. The goal is the whole backend; [the roadmap](docs/migration-roadmap.md) lists
every slice and its status. Done so far: authentication, voting
([notes](docs/votes-migration.md)), posting questions, answers and comments
([notes](docs/posts-migration.md)), and changing them: editing, selecting answers, closing,
hiding, moderating, deleting and claiming ([notes](docs/post-changes-migration.md)),
flagging ([notes](docs/flags-migration.md)), favorites ([notes](docs/favorites-migration.md)), private messages and wall posts
([notes](docs/messages-migration.md)), and account and profile changes ([notes](docs/account-migration.md)).
For an annotated, file-by-file code walkthrough, see
[the developer implementation guide](MIGRATION_IMPLEMENTATION.md).

## What works

- Register with username, email, and password; automatically sign in.
- Log in with username or email, check the current session, and log out.
- Use signed JWT cookies with database-backed revocation; logout invalidates the token immediately.
- Verify existing PHP bcrypt passwords and upgrade legacy salted-SHA-1 hashes.
- Preserve tested validation, duplicate checks, account flags, and initial reputation.
- Demonstrate authentication through Q2A's original pages, theme, CSS, and JavaScript.
- Vote on questions, answers and comments through Node, with PHP's permission checks, rate
  limits, points, hotness and cached counts. The original vote buttons call it through the bridge.
- Ask questions, answer and comment through Node, signed in or anonymously, including the
  moderation queue, the search word index, cached counts, points and update streams. The
  original ask page and question page forms call it through the bridge.
- Edit, retag and move posts, turn answers into comments, select the best answer, close and
  reopen, hide and show, approve and reject queued posts, delete hidden posts and claim
  anonymous ones through Node, from the original question page buttons and forms.
- Flag posts, take a flag back and clear flags through Node; a post that reaches the flag
  threshold is hidden in the same request.
- Add and remove favorite questions, users, tags and categories through Node, from the
  favorite buttons (with or without JavaScript).
- Send and delete private messages, and post on and delete from user walls, through Node.
- Save your profile, change your password, upload an avatar, confirm your email address, reset a
  forgotten password and unsubscribe from mailings through Node, with Node sending the emails.

## Start the demo

With Docker Desktop running, execute from the repository root:

```sh
# First setup only: create the local configuration
cp .env.example .env
docker compose up --build -d --wait
```

Edit the root `.env` to set `AUTH_JWT_SECRET` and `BCRYPT_SALT_ROUNDS` (default `10`).
Compose passes these to the API and test containers. `.env` is ignored by Git and
excluded from Docker build contexts; `.env.example` is the committed demo template.
After changing values, run `docker compose up --build -d --wait` again. Changing
the JWT secret invalidates existing sessions. For local Node startup,
`npm --prefix node-api start` also loads the root `.env`; database settings must
point to an accessible MySQL instance.

| Open | Purpose |
| --- | --- |
| http://localhost:8081/?qa=login | Original Q2A UI using Node authentication |
| http://localhost:8081/?qa=register | Original registration form using Node authentication |
| http://localhost:8080/?qa=login | Original PHP login |
| http://localhost:8080/?qa=register | Original PHP registration |
| http://localhost:8025 | Mailpit: every email both sites and the API send (confirmations, password resets) |
| http://localhost:3000/health | Node API health |

Seeded users: `alice`, `bob`, `carol` and `legacy` (legacy has an old salted-SHA-1 hash),
all with password `Password123!`, in either application. Log in with the username or
`<name>@example.test`. The seed also creates demo questions, answers, comments and votes
(once, on the first start), so there is content to browse and vote on straight away.
Both have separately seeded MySQL databases. Registering a new user in one does
**not** create that user in the other. Their sessions are independent too.

Both sites use the same frontend files from `qa-theme/`, `qa-content/`, and Q2A's
existing page controllers. There is no separate demo design or duplicated frontend.
On port 8081, a small PHP bridge forwards authentication to the Node REST API;
PHP still renders the existing UI. Authentication, voting and posting have been migrated; the
other Q2A features visible in the UI still run PHP until their slice is done (see the roadmap).
Vote responses on port 8081 carry `X-Q2A-Vote-Backend: node-api-v1`, and new posts
`X-Q2A-Post-Backend: node-api-v1`.

### Try voting

On port 8081, log in as any seeded user, open a question someone else wrote (Q2A does not
let you vote on your own posts), and click the up or down arrow. With developer tools →
Network open, the vote request (`qa=ajax`, `qa_operation=vote`) returns
`X-Q2A-Vote-Backend: node-api-v1`. Asking a question, answering or commenting on port 8081
also goes through Node; the form submission's response carries `X-Q2A-Post-Backend: node-api-v1`.

Databases created before the demo content was added get it on the next
`docker compose up --build -d --wait`. To start from a clean seed, run
`docker compose down -v` first (this deletes both development databases).

To call the API directly, log in first so the session cookie is set:

```sh
curl -c jar -H 'X-Q2A-Request: 1' -H 'Content-Type: application/json' \
  -d '{"emailhandle":"legacy","password":"Password123!"}' http://localhost:3000/api/v1/auth/login
curl -b jar -X PUT -H 'X-Q2A-Request: 1' -H 'Content-Type: application/json' \
  -d '{"vote":1}' http://localhost:3000/api/v1/posts/1/vote
```

## Five-minute presentation walkthrough

1. **Explain the scope (30 seconds).** “We migrated Q2A's core authentication into
   a versioned Node API. We compare its behavior with the original PHP application.”
2. **Show original behavior (45 seconds).** Open the PHP login page. Log in with
   `alice`, show the account page, and log out.
3. **Show migrated login (60 seconds).** Open `http://localhost:8081/?qa=login`.
   Show that it is the same Q2A interface. Log in with `alice` / `Password123!`.
   Point to the signed-in username, refresh to prove session persistence, then log out.
   Visit `/?qa=account` to show that authentication is required again.
4. **Show registration (60 seconds).** Select **Register** on port 8081. Use a fresh username
   (under 20 characters), email such as `demo123@example.test`, and an eight-or-more
   character password. Show automatic login. Log out, then
   register the same details again to show duplicate validation in the original form. For repeated
   demos, use a new username/email instead of deleting the databases.
5. **Show a failure (30 seconds).** Try logging in with a wrong password. Show the
   error on Q2A's login page. Invalid credentials do not establish a new session.
6. **Show evidence (60 seconds).** Run the commands below and explain that browser
   success alone is not proof of parity. Tests compare real PHP/Node outcomes and
   stored records, including cases not visible in the demo.

To compare registration side by side, submit the same new credentials separately
on PHP and Node. Explain that HTML/redirects and JSON differ intentionally; account
creation, validation, and authentication are the behaviors being compared.

### Prove that the unchanged UI uses Node

Open browser developer tools → Network before submitting the form on port 8081.
The form response includes `X-Q2A-Auth-Backend: node-api-v1`. The browser submits
the existing PHP form; the bridge calls Node internally, so the Node JSON request
does not appear as a separate browser request. Successful Node sessions are stored
in `node_auth_sessions`, and each page checks the session through Node's `/me`.
The bridge does not fall back to PHP password verification when Node is unavailable.

For JSON response/status demonstrations, use Postman against port 3000 as a
separate part of the presentation. The original Q2A pages continue displaying
their existing HTML and redirects. The automated bridge tests verify that UI
registration creates Node database records and a Node session.

## Run tests

All commands below run from the repository root:

```sh
# API contracts, password compatibility, and security checks in Docker
docker compose run --rm --no-deps tests npm test

# Real PHP-versus-Node comparisons and MySQL checks
docker compose run --build --rm tests
```

To run one parity suite only, pass its file:

```sh
docker compose run --build --rm tests npx jest --runInBand tests/parity/votes.test.js
```

Alternatively, with Node 24 installed: `cd node-api`, `npm ci`, then `npm test`.
The parity suite needs the Docker stack, because it talks to both sites and both databases.

The API suite replaces database access with an in-memory test implementation.
Its authentication tests verify JWT claims and reject tampered, expired, and
wrong-audience tokens before a session database lookup. Logout checks that a
previously valid cookie can no longer access `/me`.
The parity suite submits real PHP forms with CSRF tokens and sends equivalent
Node JSON requests to separate MySQL databases. It checks successful/failed
operations, authenticated state, user records, points, password upgrades, duplicate
registration races, transaction rollback, and session expiry. It does not compare
HTML with JSON or randomly salted hashes byte-for-byte. Tests add synthetic users;
run them only against the development stack. A GitHub Actions workflow template is
in [`docs/node-auth-workflow.yml`](docs/node-auth-workflow.yml); CI is not active
until it is installed under `.github/workflows/`.

## API and code map

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/auth/register` | Create an account and session |
| `POST /api/v1/auth/login` | Authenticate and create a session |
| `GET /api/v1/auth/me` | Read the signed-in user |
| `POST /api/v1/auth/logout` | Revoke the session |
| `PUT /api/v1/posts/:postid/vote` | Set, change or remove a vote (`-1`, `0`, `1`) |
| `POST /api/v1/questions` | Ask a question |
| `POST /api/v1/questions/:id/answers` | Answer a question |
| `POST /api/v1/posts/:id/comments` | Comment on a question or answer |
| `PATCH /api/v1/posts/:id` | Edit a post, or turn an answer into a comment |
| `PUT /api/v1/questions/:id/selected-answer` | Select or unselect the best answer |
| `POST`, `DELETE /api/v1/questions/:id/close` | Close (note or duplicate link) or reopen |
| `POST /api/v1/posts/:id/status` | Hide, reshow, approve or reject |
| `DELETE /api/v1/posts/:id` | Delete a hidden post |
| `POST /api/v1/posts/:id/claim` | Claim an anonymous post |
| `PUT /api/v1/posts/:id/flag` | Flag a post (hidden once it has enough flags) |
| `DELETE /api/v1/posts/:id/flag` | Take back your flag |
| `DELETE /api/v1/posts/:id/flags` | Clear every flag on a post |
| `PUT /api/v1/favorites/:type/:id` | Add a question, user, tag or category to your favorites |
| `DELETE /api/v1/favorites/:type/:id` | Remove it from your favorites |
| `POST /api/v1/users/:handle/messages` | Send a private message |
| `DELETE /api/v1/messages/:box/:id` | Delete a private message from your inbox or outbox |
| `POST /api/v1/users/:handle/wall` | Post on a user's wall |
| `DELETE /api/v1/wall-posts/:id` | Delete a wall post |
| `PATCH /api/v1/account` | Save your profile |
| `PUT /api/v1/account/password` | Change your password |
| `PUT /api/v1/account/avatar` | Upload an avatar (the image is the body) |
| `POST /api/v1/account/confirmation-email` | Email yourself a new confirmation link |
| `POST /api/v1/account/confirm-email` | Confirm an email address with its code |
| `POST /api/v1/account/password-reset` | Email a password reset code |
| `POST /api/v1/account/password-reset/complete` | Set a new password with that code and sign in |
| `POST /api/v1/account/unsubscribe` | Unsubscribe from mailings |

Direct API POST requests require JSON and `X-Q2A-Request: 1`. The bridge supplies
these after checking Q2A's existing CSRF token and stores the signed JWT
in an HttpOnly cookie. The API verifies its signature and expiry, then checks
the token hash in MySQL so logout can revoke it. The browser sends the cookie
automatically; the frontend does not store the JWT in localStorage or send an
`Authorization: Bearer` header. PHP's reference login uses its own session flow.
Use v2 only for breaking contract changes; compatible changes remain in v1.

| Location | Responsibility |
| --- | --- |
| `node-api/src/routes/v1/auth.js` | HTTP routes, cookies, request protection, rate limiting |
| `node-api/src/services/auth.js` | Validation and password/authentication logic |
| `node-api/src/repositories/users.js` | MySQL queries and transactions |
| `node-api/src/routes/v1/posts.js` | Vote, question, answer and comment routes |
| `node-api/src/services/votes.js`, `repositories/votes.js` | Voting rules and SQL |
| `node-api/src/services/posts.js`, `repositories/posts.js` | Posting rules and SQL |
| `node-api/src/services/post-changes.js` | Editing, selecting, closing, status, deleting, claiming and flags |
| `node-api/src/services/favorites.js`, `repositories/favorites.js`, `routes/v1/favorites.js` | Favorites and their update streams |
| `node-api/src/services/messages.js`, `repositories/messages.js`, `routes/v1/messages.js` | Private messages and wall posts |
| `node-api/src/services/account.js`, `repositories/account.js`, `routes/v1/account.js` | Profile, password, avatar, confirmation, reset and unsubscribe |
| `node-api/src/q2a/mail.js`, `q2a/paths.js` | Q2A's email sending (through its SMTP options) and its links |
| `node-api/src/services/post-common.js` | Shared posting input rules, page button rules and index/event helpers |
| `node-api/src/repositories/shared.js` | Transactions and SQL shared by features (points, hotness, limits) |
| `node-api/src/q2a/` | Shared ports of Q2A options, permissions/limits, points formulas and text/word splitting |
| `qa-plugin/node-auth-bridge/` | Thin adapter from original Q2A forms to Node authentication |
| `qa-theme/`, `qa-content/` | Existing shared frontend assets; no redesign |
| `node-api/tests/` | API and parity suites |
| `docker/php/` | PHP image, configuration, and original-Q2A schema/fixture setup |
| `compose.yaml` | PHP reference, shared-frontend demo, Node, seed jobs, and isolated MySQL services |
| `qa-include/pages/login.php`, `pages/register.php` | Original PHP controllers |

## Boundaries and troubleshooting

This slice excludes password reset, email delivery/confirmation, CAPTCHA, external
login, and a complete migration of Q2A. API session and rate-limit semantics have
documented differences from PHP. See [the detailed authentication notes](docs/auth-migration.md)
for supported settings, implementation choices, and remaining parity gaps.

- **Page unavailable:** start Docker Desktop, run the startup command, then check
  `docker compose ps` and `docker compose logs --tail=50 api php`.
- **UI unchanged after edits:** rebuild with `docker compose up --build -d --wait`.
- **Duplicate account on repeat demo:** use a fresh synthetic username/email.
- **PHP-created user missing in Node:** expected; the databases are isolated.
- **Stop:** `docker compose down` preserves data. `docker compose down -v` deletes
  these development databases; use only when intentionally resetting synthetic data.

Local credentials and the `.env.example` JWT secret are for demonstration, not
production deployment. A production host must supply its own secret of at least
32 bytes. Deploying this change invalidates previously issued opaque sessions;
users must log in again.
