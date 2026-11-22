# Milestone 1 HTTPS demo

Run one Docker Compose project on an isolated demo VM. The EC2 demo uses
`https://comp4537-q2a.duckdns.org` for the PHP client and
`https://comp4537-api.duckdns.org` for the Node REST API. Both are publicly
reachable during the demo window.

Caddy terminates HTTPS for both names. Only Caddy publishes ports. PHP talks to
Node over the private Docker application network, and PHP and Node share a
persistent MySQL database on a separate private network. Mailpit catches demo
email privately. Caddy's administration API is disabled. Its API virtual host
routes only the public API groups and health check, and strips the bridge key
header. The PHP bridge reaches internal routes directly over Docker, using its
server-side secret.

The existing Q2A pages send same-origin requests to PHP. PHP relays them to
Node, including AI evaluation and the AI Usage dashboard. The PHP session
cookie belongs to the UI hostname. API login creates a separate, host-only API
session cookie. The two DuckDNS names are cross-site because
[`duckdns.org` is on the Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat).
CORS allows the frontend to read public API responses, and the API's
`SameSite=Strict` cookie is used on the API site.

## Prepare the environment

1. Choose an isolated VM with current Docker Engine and the Docker Compose
   plugin. Keep SSH and other management services restricted to operators.
   Do not connect this project to a production database or publish Mailpit.
2. Point both DNS names at the VM. Allow inbound TCP 80 and 443 for Caddy's
   automatic HTTPS and redirects. Point DNS directly at the host for this
   setup, with no intervening CDN or load balancer.
3. Copy `.env.demo.example` to `.env.demo`. Restrict the file to the operator
   account and set the values below. On Linux, use `chmod 600 .env.demo`.
   Generate a separate random value for each password or secret, for example
   with `openssl rand -hex 32`.

| Variable | Value |
| --- | --- |
| `DEMO_UI_HOST`, `DEMO_API_HOST` | Distinct hostnames without scheme, port, or trailing slash |
| `DEMO_ACME_EMAIL` | Operator email for certificate management |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | Independent MySQL credentials. Only MySQL receives the root password. |
| `AUTH_JWT_SECRET`, `BRIDGE_SECRET` | Independent private signing and bridge secrets |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Server-side key and optional model override. The key is passed only to Node. |
| `Q2A_MILESTONE_DEMO_ACCOUNTS` | Set to `1` for the two assignment accounts |

CORS is derived from `DEMO_UI_HOST` and allows exactly its HTTPS origin.
Existing `.env.demo` files may keep the obsolete `DEMO_ALLOWED_IPS` setting.
The application network
uses `172.31.249.0/24`. If it overlaps a host network, update the addresses in
`compose.demo.yaml` and Apache's trusted proxy in
`docker/php/demo-https.conf` together.

The required administrator credentials are publicly known. During the public
window, anyone who uses them can administer the demo application, change demo
content or settings, and incur OpenAI costs. Keep the deployment isolated
from production and use only synthetic data. Open it just before instructor
testing and close it as soon as grading is complete. Keep the EC2 security
group limited to ports 80 and 443 for public web traffic and restrict SSH to
operators. MySQL, Mailpit, Apache, and Node should have no host port bindings.

## Update the existing EC2 deployment

Run these commands from the existing EC2 checkout on `wynn/ai-backend` once
the reviewed revision is present. Keep the existing `.env.demo`, project
name, and volumes. If the deployment was started with an explicit Compose
project name, use the same `-p` value in each command. Only Caddy is recreated,
so expect a brief interruption at both HTTPS origins.

```sh
git status --short --branch
docker compose --env-file .env.demo -f compose.demo.yaml config --quiet &&
docker compose --env-file .env.demo -f compose.demo.yaml exec -T caddy \
  caddy validate --config - --adapter caddyfile < docker/demo/Caddyfile &&
docker compose --env-file .env.demo -f compose.demo.yaml up -d \
  --no-deps --force-recreate --wait caddy &&
docker compose --env-file .env.demo -f compose.demo.yaml ps
```

## Start a fresh demo when approved

```sh
docker compose --env-file .env.demo -f compose.demo.yaml config --quiet
docker compose --env-file .env.demo -f compose.demo.yaml up -d --build --wait
docker compose --env-file .env.demo -f compose.demo.yaml ps
```

MySQL starts first. The existing seeder creates the Q2A and AI tables and
optionally installs demo accounts. Node waits for seeding, PHP waits for the
API health check, and Caddy waits for both. Use a fresh demo volume on the VM.
Seeding preserves stored options and accounts on subsequent starts. If a
reused demo database has the wrong Site URL, correct it in Q2A administration.
Keep Q2A's default query-string URL structure for this profile.

## Verify the public origins

Check the redirects, public routes, authorization, and exact CORS response
from a network outside EC2.

```sh
curl -I 'http://comp4537-q2a.duckdns.org/?qa=login'
curl -I 'http://comp4537-api.duckdns.org/health'
curl -fsS -o /dev/null 'https://comp4537-q2a.duckdns.org/?qa=login'
curl -fsS 'https://comp4537-api.duckdns.org/health'
curl -i 'https://comp4537-api.duckdns.org/api/v1/admin/ai/usage'
curl -i 'https://comp4537-api.duckdns.org/api/v1/internal/reads'
curl -i -X OPTIONS 'https://comp4537-api.duckdns.org/api/v1/auth/login' \
  -H 'Origin: https://comp4537-q2a.duckdns.org' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-q2a-request'
```

Expect HTTP-to-HTTPS redirects, 200 for the login page and health, 401 for
anonymous admin usage, 404 for the internal route, and 204 for preflight with the exact UI origin and
`Access-Control-Allow-Credentials: true`. Repeat preflight with an unrelated
origin and expect 403 without an allow-origin header. Confirm in `docker
compose ps` that only Caddy has host port bindings.

To run the edge smoke tests with Node 24, set `DEMO_TEST_UI_ORIGIN` and
`DEMO_TEST_API_ORIGIN` to the two HTTPS URLs, then run
`node --test docker/demo/smoke-test.cjs`. To include the regular-user login
test against a disposable demo database, also supply `DEMO_TEST_USER_EMAIL`
and `DEMO_TEST_USER_PASSWORD` through the environment.

## Demonstrate Q2A and the direct API

- Open `https://comp4537-q2a.duckdns.org/?qa=login`. Sign in as `john@john.com`
  with the assigned milestone password. Evaluate an answer on a seeded question and open **AI
  Evaluation History** to show the saved result. The deployed evaluation uses
  the configured OpenAI account and incurs usage.
- Sign out and sign in as `admin@admin.com` with the assigned milestone password. Open
  `/?qa=admin/ai-usage` to show totals and the date and status breakdowns.
  The John account should be denied access. The admin role applies to Q2A
  application administration only.
- From the HTTPS Q2A tab, run
  `await fetch('https://comp4537-api.duckdns.org/health').then(r => r.json())`
  in DevTools to show a direct cross-origin browser request.
- For authenticated direct API requests, open
  `https://comp4537-api.duckdns.org/health` in its own browser tab. Run this
  example in that tab's DevTools and enter the administrator's demo
  credentials at the prompts. Use the Network panel to show login, authorized
  usage, and logout.

```js
{
  const api = '/api/v1';
  const headers = { 'Content-Type': 'application/json', 'X-Q2A-Request': '1' };
  const login = await fetch(api + '/auth/login', {
    method: 'POST', headers, credentials: 'include',
    body: JSON.stringify({
      emailhandle: prompt('Demo account email'),
      password: prompt('Demo account password'),
    }),
  });
  if (!login.ok) throw new Error('API login failed: ' + login.status);
  try {
    const usage = await fetch(api + '/admin/ai/usage', { credentials: 'include' });
    console.log(usage.status, await usage.json());
  } finally {
    await fetch(api + '/auth/logout', {
      method: 'POST', headers, credentials: 'include', body: '{}',
    });
  }
}
```

Run the same example with John to demonstrate that the API independently
returns 403. In DevTools, the UI bridge cookie and the API session cookie
should both be Secure and HttpOnly, belong to their respective hosts, and have
`SameSite=Strict`.

After grading, close public access by running
`docker compose --env-file .env.demo -f compose.demo.yaml stop caddy`.
To shut down the full isolated demo, use
`docker compose --env-file .env.demo -f compose.demo.yaml down`, which preserves
the MySQL and certificate volumes. Setting the demo seed flag to zero alone
leaves accounts previously seeded on that volume.
