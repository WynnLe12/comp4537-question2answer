# Milestone 1 HTTPS demo

Run one Docker Compose project on an isolated demo VM. Use sibling hosts under
the same registered domain, such as `https://qa.example.com` for the PHP client
and `https://api.example.com` for the Node REST API. They are separate origins
and remain on the same site for the existing `SameSite=Strict` cookies.

Caddy terminates HTTPS for both names. Only Caddy publishes ports. PHP talks to
Node over the private Docker application network, and PHP and Node share a
persistent MySQL database on a separate private network. Mailpit catches demo
email privately. Caddy's administration API is disabled. Its API virtual host
routes only the public API groups and health check, and strips the bridge key
header. The PHP bridge reaches internal routes directly over Docker, using its
server-side secret.

The existing Q2A pages still send same-origin requests to PHP. PHP relays them
to Node, including AI evaluation and the AI Usage dashboard. Show the direct
browser calls below as a separate step to demonstrate client-to-API traffic
across origins. The PHP session cookie belongs to the UI hostname. Logging in
from the browser to the API creates a separate, host-only API session cookie.

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
| `DEMO_UI_HOST`, `DEMO_API_HOST` | Distinct sibling hostnames without scheme, port, or trailing slash |
| `DEMO_ACME_EMAIL` | Operator email for certificate management |
| `DEMO_ALLOWED_IPS` | Space-separated source IP addresses or CIDRs for the demo audience, including the presenter and grader |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | Independent MySQL credentials. Only MySQL receives the root password. |
| `AUTH_JWT_SECRET`, `BRIDGE_SECRET` | Independent private signing and bridge secrets |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Server-side key and optional model override. The key is passed only to Node. |
| `Q2A_MILESTONE_DEMO_ACCOUNTS` | Set to `1` for the two assignment accounts |

CORS is derived from `DEMO_UI_HOST` and allows exactly its HTTPS origin. Keep
the IP list narrow because the demo uses shared passwords. Caddy checks the
connection source IP before serving either site. Review the attendee list if
someone connects through a VPN or shared network. The application network
uses `172.31.249.0/24`. If it overlaps a host network, update the addresses in
`compose.demo.yaml` and Apache's trusted proxy in
`docker/php/demo-https.conf` together.

## Start and verify when approved

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

Check the redirects, health endpoint, private route, and exact CORS response
from an allowlisted network. Use your actual hostnames in these commands.

```sh
curl -I 'http://qa.example.com/?qa=login'
curl -I 'http://api.example.com/health'
curl -fsS 'https://api.example.com/health'
curl -i 'https://api.example.com/api/v1/internal/reads'
curl -i -X OPTIONS 'https://api.example.com/api/v1/auth/login' \
  -H 'Origin: https://qa.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-q2a-request'
```

Expect HTTP-to-HTTPS redirects, a healthy API response, a 404 for the internal
route, and a 204 for preflight with the exact UI origin and
`Access-Control-Allow-Credentials: true`. Repeat preflight with an unrelated
origin and expect 403 without an allow-origin header. From outside the audience
allowlist, confirm that both HTTPS sites return 403.

## Demonstrate Q2A and the direct API

- Open `https://qa.example.com/?qa=login`. Sign in as `john@john.com` with
  password `123`. Evaluate an answer on a seeded question and open **AI
  Evaluation History** to show the saved result. The deployed evaluation uses
  the configured OpenAI account and incurs usage.
- Sign out and sign in as `admin@admin.com` with password `111`. Open
  `/?qa=admin/ai-usage` to show totals and the date and status breakdowns.
  The John account should be denied access. The admin role applies to Q2A
  application administration only.
- From the HTTPS Q2A tab, open the browser developer console. Run this example
  with the actual API hostname and use the administrator's demo credentials at
  the prompts. Use the Network panel to show the cross-origin login and usage
  request, then the logout. The existing dashboard continues to use PHP.

```js
{
  const api = 'https://api.example.com/api/v1';
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

After the milestone, shut down the isolated demo with
`docker compose --env-file .env.demo -f compose.demo.yaml down`, which preserves
the MySQL and certificate volumes. Setting the demo seed flag to zero alone
leaves accounts previously seeded on that volume.
