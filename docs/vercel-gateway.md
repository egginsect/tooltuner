# Vercel gateway setup and verification

This repository includes a request-only Vercel Node.js entry point. Local implementation and
synthetic tests are preparation evidence, not a deployment receipt. No Vercel project,
database, account, secret, upstream connection, or public release is created by this change.
Deployment, account setup, credential installation and client enrollment remain separate
operator-approved steps.

## Runtime boundary

- `api/index.ts` exports one Node request handler; all paths rewrite to that function.
- `src/hosted.ts` lazily composes `createRuntime` and shares a single initialization promise
  between concurrent requests in the same warm instance. It does not call `listen`, install
  process signal handlers, probe its own public URL, or start a subprocess.
- MCP is stateless Streamable HTTP with JSON responses. No connection-local sessions or
  standalone SSE subscriptions are required. Clients use `/mcp` and discover the OAuth
  endpoints on the same fixed origin.
- Pending authorization, owner-authenticated grant selection, codes, tokens, grants, registry
  records and evidence live in the shared FalkorDB graph. Replacing an instance must not
  discard a pending OAuth interaction. One-time capabilities retain atomic consumption.
- Hosted OAuth rate limits use shared graph counters for `/authorize`, `/token`, `/register`,
  `/revoke`, `/oauth/owner-login` and `/oauth/consent`. Buckets are endpoint-global for this
  single-owner gateway, so spoofed forwarding headers cannot evade them. They fail closed
  when storage fails. Default budgets are 100 authorizations, 50 token requests, 50
  revocations and 20 owner-login/consent requests per 15 minutes; registration allows 20
  per hour. Heavy traffic from one client can limit others. Use separate graphs for separate
  gateways/environments; sharing a graph also shares these budgets.
- Local runners, job starts, local fixture seeding and deployment managers are disabled.
  The hosted process must not receive the manager's `VERCEL_TOKEN`. Local `npm start`,
  owner commands and synthetic demo workflows remain available outside hosted mode.

## Existing project settings

Use an existing approved project and select Node 24, matching `package.json` and `.nvmrc`.
Keep the repository root as the project root. `vercel.json` declares Framework Preset Other
(`framework: null`), `npm ci`, a typecheck build step, a 60-second function duration, the
catch-all rewrite and the explicit `public` static output directory. That directory contains
only a robots exclusion file; repository sources must never be configured as static output.
No project ID, team ID, account name or deployment-specific hostname is committed.
The explicit project-relative `typeRoots` keeps Node type resolution stable when the
Vercel TypeScript compiler creates an extending configuration in a temporary directory.

`.vercelignore` excludes local secrets, deployment metadata, runtime state, tests and docs
from CLI source uploads. This is defense in depth, not permission to keep secrets in tracked
files. Import the entry point without secrets at build time; environment validation and
storage connections occur only on the first request.

References: [Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js),
[project configuration](https://vercel.com/docs/project-configuration/vercel-json), and
[function duration](https://vercel.com/docs/functions/configuring-functions/duration).

## Required environment

Set these through the approved deployment secret/settings workflow. Do not commit actual
values, copy another checkout's `.env` or `.vercel` state, or print credentials in logs.

| Variable | Requirement |
| --- | --- |
| `FLYWHEEL_PUBLIC_ORIGIN` | One fixed public HTTPS origin, without a path or trailing slash. Never infer it from a request Host header or ephemeral preview URL. |
| `FLYWHEEL_OWNER_ID` | The owner namespace used by existing grants and registry records. Defaults to `owner`. |
| `FLYWHEEL_OWNER_SECRET` | A high-entropy consent secret, at least 32 characters in hosted mode. |
| `FALKORDB_URL` | An external TLS endpoint using `rediss://` or `falkors://`, with no embedded credentials. Loopback and plaintext endpoints are rejected. |
| `FALKORDB_GRAPH` | A dedicated graph for this gateway/environment. |
| `FALKORDB_USERNAME` | The service's ACL username if required. |
| `FALKORDB_PASSWORD` | The service's authentication secret. Required in hosted mode. |
| `FALKORDB_CONNECT_TIMEOUT_MS` | Initial TCP connection timeout, default 3000 ms, allowed 100–15000. |
| `FALKORDB_QUERY_TIMEOUT_MS` | Per-query timeout, default 5000 ms, allowed 100–30000. Timed-out writes remain outcome-unknown. |

The entry point forces `FLYWHEEL_RUNTIME_MODE=hosted`, even if the deployment accidentally
sets `local`. `OAUTH_RESOURCE`, when supplied, must equal the fixed origin plus `/mcp`;
`OAUTH_ISSUER` must equal the fixed origin. Do not set `RUNNER_CONFIG_PATH`,
`FIXTURE_REGISTRY_PATH` or `VERCEL_TOKEN` in the hosted environment; startup rejects them.

The graph service must support the existing range indexes and unique constraints. Provision
and verify schema on a trusted operator path before exposing traffic to reduce cold-start
work. Schema bootstrap remains idempotent on cold starts. Do not weaken storage access or
public exposure settings solely to pass a health check. External storage, network reachability,
TLS trust and deployment protection still need provider-environment verification.

## Optional encrypted upstream credential custody

To resolve enrolled protected upstreams without loading a local runner file, also supply:

- `FLYWHEEL_CREDENTIAL_POSTGRES_URL`: the dedicated PostgreSQL connection string, without
  URL query parameters. TLS certificate verification stays enabled.
- `FLYWHEEL_CREDENTIAL_KEYS`: the external versioned JSON keyring described in
  [credential custody](postgres-credentials.md).
- `FLYWHEEL_CREDENTIAL_ACTIVE_KEY_VERSION`: the matching active encryption key version.
- `FLYWHEEL_CREDENTIAL_POSTGRES_CONNECTION_MODE`: explicitly `direct` or `session`.

Transaction-pooling endpoints are unsupported: refresh fencing uses PostgreSQL session
advisory locks across the upstream request. The mode variable is an operator declaration,
not automatic detection of a provider's pool behavior. Verify the actual provider endpoint
and its session-affinity guarantees before installing credentials. Never select `session`
merely to silence validation.

The existing adapter limits each warm instance to five PostgreSQL connections, bounded
connection/query timeouts and short idle retention. Account for the number of concurrent
function instances in the database connection budget. The hosted function does not run DDL
for PostgreSQL; initialize its schema separately using the established owner workflow and
retain a least-privilege runtime role. Existing target bindings and refresh fences remain in
force. Optional custody configuration does not enroll an upstream or verify its credentials.

## Startup failures and request duration

Cold initialization has a 25-second response deadline. Failures return a sanitized,
non-cacheable 503 without configuration values or stack traces. Ordinary initialization
failure clears the cached promise, allowing a later request to retry. Partially composed
credential stores and completed database clients are closed on failure.

A TCP timeout does not necessarily bound a Redis server that accepts a socket and never
answers its protocol handshake. The current driver does not expose safe pre-connection
cancellation. If initialization exceeds the response deadline, the warm instance retains
one fenced pending attempt instead of spawning overlapping connections. That instance
returns 503 until the attempt settles or the platform recycles it; a late successful runtime
is closed. Initial reconnect retries are disabled in hosted mode. After the first successful
connection, the existing reconnect recovery remains enabled, with offline write queues
still disabled. This preserves outage recovery without replaying queued writes.

Request/response completion is awaited by the function. Do not use this function for long
coding jobs or background runners. A platform timeout during an admitted dispatch can leave
its durable call outcome unknown; inspect recorded evidence and use existing idempotency
semantics instead of blindly replaying a write. Configure upstream deadlines below the
function budget and verify the selected provider plan's duration limits.

## Verification gates

Before any approved deployment:

1. Run `npm ci`, `npm run typecheck` and `npm test` on Node 24.
2. Run `npm run test:integration` against an owned throwaway FalkorDB. The hosted rate-limit
   test verifies concurrent increments, endpoint isolation, persistence across clients and
   expiry. Pending-consent tests cover instance replacement and single-use capabilities.
3. Review the exact file diff and check that no `.env`, `.vercel`, credential values, owner
   identifiers, deployment hostnames or local operator paths enter the delivery artifact.

After deployment is separately authorized and succeeds, verify from outside the platform:

1. `/healthz` reaches the external graph and returns 200; a controlled storage failure
   returns 503. A healthy graph does not prove upstream authorization.
2. `/.well-known/oauth-authorization-server` and protected-resource metadata advertise
   only the chosen fixed origin and its `/mcp` resource.
3. Unauthenticated `/mcp` is 401 with correct resource metadata. Authenticated clients see
   exactly `list_apps`, `describe`, `dispatch` and only grant-authorized inner tools.
4. DCR, S256 PKCE, owner login, separate grant selection, code exchange, refresh and grant
   revocation work through actual Vercel rewrites. Start authorization on one cold instance
   and complete it on another; replayed consent/code/token operations fail appropriately.
5. Rate limits persist across separate instances and cannot be bypassed using altered
   forwarding headers. Storage failure blocks OAuth mutation rather than permitting it.
6. Verify actual database TLS, PostgreSQL session affinity (if configured), connection
   budgets, deployment protection, request duration and the intended MCP client's access.

A successful local unit suite or a valid `vercel.json` does not establish any of these live
provider/client checks. Record their actual results before calling the deployment ready.
