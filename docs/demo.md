# Start here: local demonstration

For the reproducible, account-free local loop, use [the local demo walkthrough](local-demo.md).
The operator runbook below covers additional hosted and real-provider milestones.

# Operator runbook (TOO-72, TOO-77)

## Local evidence and persistent startup

Run the install/check commands in the README, then `npm run demo`. Save its credential-free
JSON output with `npm --silent run demo > /tmp/flywheel-local-sdk-receipt.json`. This is a real
local SDK exercise and cleans up its own graph. For persistent operator work, use the default
graph or a deliberately chosen dedicated graph; never delete a shared graph to reset the demo.

Start the local fixtures in a separate terminal:

```sh
npx tsx fixtures/server.ts 8790
```

Create a local JSON configuration outside the repository with this shape, replacing the commit
with the full result of `git rev-parse HEAD` from the exact clean fixture checkout:

```json
{
  "baseUrl": "http://127.0.0.1:8790",
  "source": { "repo_id": "tooltuner/mcp-flywheel-oss", "commit_sha": "<FULL_CLEAN_CHECKOUT_SHA>" },
  "initializeStable": true
}
```

Set `FIXTURE_REGISTRY_PATH` to that file and run `npm start`. Startup discovers the actual MCP
catalogs, registers immutable v1 versions, and initializes stable only because this configuration
explicitly requests it. Subsequent starts at the same identity are idempotent. Changing v1 source,
URL or schema is a conflict; register a distinct version instead. The fixture app list is
`config/fixtures.json`; the path environment variable refers to the runtime configuration above.
The corrected reference endpoint is never seeded automatically.

If a port is busy, choose `PORT` explicitly. If storage is unreachable, start FalkorDB or correct
its URL. Docker's named `falkordb-data` volume retains data across ordinary restarts: do not use
`docker compose down -v` for troubleshooting. If a schema marker is incompatible, select a new
dedicated graph or plan a migration. Preserve failed/unknown records for reconciliation.

## Enroll another isolated local application

The owner CLI can enroll an actual local MCP application without changing the fixture list.
Use a fresh synthetic application database and a dedicated Flywheel graph. This path supports
anonymous Streamable HTTP on literal `127.0.0.1` or `[::1]` only; it does not link external
accounts, import connector tokens, or configure a production upstream.

Create a nonsecret JSON file outside the repository:

```json
{
  "application": "local-example",
  "description": "Isolated application with synthetic data only.",
  "label": "baseline",
  "source": { "repo_id": "owner/example", "commit_sha": "<FULL_CHECKOUT_SHA>" },
  "url": "http://127.0.0.1:8791/mcp",
  "deployment_id": "local-example-baseline",
  "parent_version_id": null,
  "tools": ["read_example"]
}
```

```sh
npm run owner -- application enroll-local --input /path/to/local-app.json --subject local-operator
```

The command performs actual MCP initialization and paginated catalog discovery, compiles tool
schemas, and stores an immutable application/version snapshot. It never calls business tools.
The optional `tools` list enrolls only those exact live capabilities; unknown names are rejected.
Omit it to validate and enroll the entire catalog. This can isolate a read-only integration from
unrelated write tools. It does not grant access: per-client grants still apply at dispatch.
The exact source and deployment identity are owner assertions (`owner_config`), not provider
attestations. An anonymous local catalog establishes only local readiness, not protected OAuth
compatibility. Do not reuse a local deployment URL for different running code during a test.
Re-enrollment of an identical label/content is idempotent; changed source, URL or schema requires
a new label. An optional parent must be an exact version ID in the same app/repository.

Enrollment never initializes or moves stable. Use the returned exact `version_id` in `describe`
and `dispatch`; missing stable remains unavailable. Create only the authorized app/tool/repository
grants described below. A read-only application call still creates Flywheel evidence, so use
synthetic inputs and outputs. Report truthful feedback, then freeze a packet with the actual
call/feedback references; a positive result is not a demonstrated defect or repair.

## Public origin and one-time owner handoff

No fixed public origin, tunnel binary/account, owner consent secret, upstream owner account,
runner configuration, or Vercel project credentials were supplied for the local receipt.
These inputs are required before claiming the corresponding gate passed.

1. The owner chooses an existing fixed HTTPS tunnel hostname and forwards its entire origin to
   `127.0.0.1:8787`. For an installed/authenticated ngrok account with a fixed dev domain, the
   intended command is `ngrok http --url=<fixed-domain> 8787`. Tunnel installation/account setup
   and this command remain unverified here. Do not tunnel only `/mcp`.
2. Set `FLYWHEEL_PUBLIC_ORIGIN=https://<fixed-domain>` with no path or trailing slash, and supply
   a strong `FLYWHEEL_OWNER_SECRET` through the operator's credential environment. Do not put it
   in shell history, screenshots or PRs. The built-in issuer is that origin; the resource is
   `https://<fixed-domain>/mcp`. Explicit `OAUTH_ISSUER`/`OAUTH_RESOURCE` must match.
3. Restart the service. The public-origin probe must match this process's `/healthz` instance ID.
   Check the advertised discovery documents at
   `https://<fixed-domain>/.well-known/oauth-authorization-server` and
   `https://<fixed-domain>/.well-known/oauth-protected-resource/mcp`. Registration, `/authorize`,
   `/token`, `/revoke`, `/oauth/owner-login`, and `/oauth/consent` must reach the same service.
4. Create separate grants, then in each real client's remote MCP connection UI enter
   `https://<fixed-domain>/mcp`. Follow the redirect to the Flywheel consent form. The owner
   first supplies the consent secret locally on the owner-login form. Only after authentication
   does the server display grant choices; select the intended grant and approve once per client
   authorization. The selection form carries a short-lived request-bound capability, never the
   owner secret. A successful flow returns to the client with the three outer tools. Capture
   `list_apps`, `describe`, and an actual `dispatch` result plus their graph refs.

ChatGPT and Claude hosted UI menu names are not verified in this environment. Locate the client's
remote MCP/custom connector entry, use the exact URL above, and record the actual navigation
with the first receipt. Do not claim an invented menu path is tested. Account login and consent
require the owner; no automation capability is assumed. Muse, Spark and other clients remain
unverified individually. An SDK script cannot satisfy either hosted-client receipt.

## Owner upstream linking and protected previews

The trusted owner CLI implements both browser PKCE authorization and linking an already
provisioned external OAuth credential. Create a **nonsecret** JSON file outside the repository:

```json
{
  "credentialStore": { "kind": "helper", "executable": "/absolute/path/to/credential-helper" },
  "account": {
    "auth_config_ref": "owner:textkit-preview",
    "credential_ref": "helper:textkit-preview",
    "application": "textkit",
    "repo_id": "tooltuner/mcp-flywheel-oss",
    "environment": "preview",
    "issuer": "https://<approved-issuer>",
    "introspection_url": "https://<approved-issuer>/introspect",
    "scopes": ["tools"]
  },
  "target": {
    "commit_sha": "<FULL_EXISTING_DEPLOYMENT_SHA>",
    "deployment_id": "<EXISTING_PREVIEW_DEPLOYMENT_ID>",
    "url": "https://<EXACT_DEPLOYMENT>.vercel.app/mcp",
    "resource": "https://<EXACT_DEPLOYMENT>.vercel.app/mcp",
    "audience": "https://<EXACT_DEPLOYMENT>.vercel.app/mcp"
  }
}
```

Run `npm run owner -- account link --input <link.json> --subject <owner> --mode browser`.
Open the printed issuer authorization URL locally, log into the intended upstream account and
approve the configured scopes. The SDK uses S256 PKCE, state and an ephemeral loopback callback;
codes/verifiers/tokens stay in memory or the external helper. The CLI acknowledges linking only
after exact protected-resource metadata, authoritative token introspection and real SDK catalog
initialization succeed. An issuer without the required introspection/resource support fails closed.
No account credentials or successful owner link were supplied for the current local receipt.

The helper reads one JSON request from stdin and returns one JSON response on stdout. Requests
are `{ "operation":"get", "reference":"helper:textkit-preview" }` or
`{ "operation":"put", "reference":"helper:textkit-preview", "value":<credential> }`.
`get` returns the credential object; `put` returns `{ "stored":true }`. The helper owns secure
keychain/encrypted persistence and must never log credentials. The bundled file helper is a synthetic
local-test fixture only; do not use it for real credentials. Its process receives only fixed
PATH and optional configured `homeDirectory`, not the manager environment. Provision this helper
against the owner's credential store; no production plaintext file-store adapter is supplied.

For an already provisioned credential use `--mode existing`. A read-only alternative sets
`credentialStore:{"kind":"environment"}` and `credential_ref:"env:UPSTREAM_PREVIEW_OAUTH"`.
The named variable must contain an SDK credential JSON object with `issuer`, `environment`,
`resource`, `audience`, Unix-seconds `obtained_at`, `client` and `tokens`. `client` contains the
SDK client information; `tokens` contains access/refresh tokens, token type, expiry and issuer.
Inject its value through the credential environment, never CLI arguments or repository files.
Read-only environment storage cannot persist refresh rotation or mint new preview resources;
the concrete deployment path requires a writable helper.

In `RUNNER_CONFIG_PATH`, add the same `credentialStore`, an absolute `vercelExecutable`, and
`previewProjects` entries with `ownerId`, `application`, `repoId`, `providerRepoId`, `projectId`,
`teamId`, `mcpPath`, `authConfigRef`, `issuer` and `scopes`. All project/repository identifiers
must refer to an existing approved Vercel project with an existing production baseline.
Supply `VERCEL_TOKEN` only to the trusted manager environment; optional `VERCEL_PROJECT_ID`
and `VERCEL_TEAM_ID` must agree with the mapping. The composition creates the manager, external
credential mediator, protected-preview verifier and immutable registry adapter. Missing inputs
leave preview operations unavailable; configuring them is not a verified deployment receipt.

The manager exports only committed artifact content and explicitly requests a preview. Provider
readback verifies team, project, repository, commit and artifact provenance before app verification.
The verifier checks anonymous, invalid-token and wrong-resource denials, exact protected resource,
issuer, scopes, authenticated SDK initialize/catalog and schema. Only then is the exact immutable
deployment's credential binding stored and the candidate registered. It never forwards the inbound
client token, changes stable, creates a Vercel project or falls back to a production deployment.

## Grants and visible authorization

Create distinct grant IDs (returned by these local owner commands). The group is chosen by the
owner and does not depend on the client brand:

```sh
npm run owner -- grant create --label demo-user --groups user --apps textkit,catalog --repos tooltuner/mcp-flywheel-oss
npm run owner -- grant create --label demo-development --groups development --apps textkit --repos tooltuner/mcp-flywheel-oss
npm run owner -- grant create --label demo-management --groups management --apps textkit --repos tooltuner/mcp-flywheel-oss
npm run owner -- grant create --label demo-union --groups user,development,management --apps textkit,catalog --repos tooltuner/mcp-flywheel-oss
npm run owner -- grant list
```

Use `--tools 'textkit:word_count,flywheel:report_feedback'` for an explicit per-app tool allowlist.
For a coding session use development only with `--packet pkt_… --job job_…` and the single app/repo.
The service additionally enforces the packet/job closure. Never give that subprocess a union,
management, owner or deployment credential. Use `grant revoke grant_…` to revoke a grant; an
existing token must then fail rather than silently gain a replacement grant.

| Session | Visible inner operations and expected success | Required direct-call denial |
|---|---|---|
| user | allowed upstream tools, `report_feedback` | raw evidence, `start_job` |
| development | `get_context`, `get_evidence` within app/repo/packet | upstream tools, `create_packet`, `start_job`, `register_preview`, other job's refs |
| management | `create_packet`; configured jobs/previews/experiments | `get_context`, `get_evidence` |
| explicit union | exactly the selected groups and tool allowlists | anything outside those lists |
| all sessions | three outer names remain constant | `merge`, `activate`, `rollback` |

Record `list_apps` and each `describe` catalog, then dispatch a known denied operation by name
without discovery. Capture the actual error: `forbidden` proves policy denial; an allowed but
unconfigured operation returns `operation_unavailable` and proves no successful management action.
Invisible apps may be `not_found` to avoid disclosing existence. `dispatch` has write effects;
host confirmation behavior belongs to the host.

## Real improvement loop and recording checklist

1. Through a real user session, dispatch `textkit.word_count` with
   `{"text":"alpha  beta\ngamma"}` on v1. Actual baseline is 2; expected is 3. Capture `call_ref`
   and the exact `resolved_version`, then call the second app's `capabilities` tool.
2. Submit `report_feedback` with that call ref, `signal:"negative"`, observed/expected and a fresh
   idempotency key. Show a durable ACK, then management `create_packet` with the call and feedback
   refs. The packet ACK contains only `packet_id`, `digest`, `missing_refs`.
3. Configure the trusted runner using `config/runtime.example.json` only after reviewing actual
   adapter requirements. Launch a real management job from the packet/base SHA. A queued record
   is not runner-start proof. Capture the real receipt, isolated checkout, allowlisted environment
   names, scoped development read, and absence of manager/Vercel/owner credentials. Missing or
   uncertain start evidence stays failed/unknown; do not resubmit blindly.
4. The coding CLI returns a clean commit and verified artifact. Only the manager can deploy that
   artifact to an already existing, configured Vercel preview project and verify provider identity,
   repository, deployment-specific URL, schema and app authentication. Do not create/link a new
   project, deploy to production, or trust a URL supplied by the job. Unconfigured protected
   runtime verification must keep previews unavailable.
5. Automatically register the verified candidate, replay the same persisted input against exact
   baseline/candidate IDs, then record recommendation separately. Show both versions through
   the same client connection without reconnecting. The reference `example-v2` is not a job result.
6. Human merge and activation need separate explicit authorization and real receipts. No such
   action is performed by this runbook. Activation checks exact artifact and expected current
   version; a post-merge rebuild needs a new identity and smoke. Rollback changes future routing
   and cannot undo past upstream side effects.
7. Restart without deleting the database volume. Read back the captured graph records, repeat a
   client call, and observe refresh/reconnect, expiry and revocation. Record actual timestamps and
   source commits. Film real success and failures, not pre-filled result JSON.

The owner CLI exposes `decision merge`, `decision activate`, and `decision rollback`, each with
`--input <receipt.json> --subject <owner identity>`. The input contains `application`,
`selected_version_id`, `expected_current_version_id`, `source`, and the actual `receipt` object.
Activation/rollback use an exact selected version and `source:null`; merge requires the actual
merged source (`repo_id`, `commit_sha`) and only records an existing receipt. It does not run
Git or activate. These commands are implemented for an explicitly authorized operator; none
was executed as part of integration.

`RUNNER_CONFIG_PATH` accepts the example's repository/config arrays. A runnable file additionally
sets an absolute `workspaceRoot`. Each runner config specifies `id`, `executable`, `args`,
`environmentAllowlist`, `writablePaths`, `checks`, `timeoutMs`, `network`, and optional
`readOnlyPaths`. `environmentRefs` maps child variable names to independently provisioned
runner-only environment variable names; values are resolved in memory. Manager/owner/project
credential references are rejected. Do not put plaintext credentials in the file. Repository
entries use `repoId`, `ownerId`, `application`, absolute `localPath`, `allowedBaseShas`, and
`runnerConfigIds`. Comparison configs use `ref`, `fixtureStateRef`, `expectedOutput`, `maxVersions`.
The empty example deliberately enables nothing.

For trusted server embedding, `createRuntime`/`startRuntime` also accept `integrations` containing
the concrete runner, manager and upstream credential resolver. The built-in
registry adapter revalidates the job/artifact receipt, deduplicates the immutable candidate by
job ID and never changes stable. MANAGEMENT alone can run configured, frozen, read-only trials
through the internal durable replay adapter. Each arm rechecks the persisted comparison and exact
version/input identity plus owner, app, tool and repository scope. This does not change the grant
or permit direct upstream dispatch or raw evidence reads.

## Graph evidence and receipt format

The graph model and bounded parameterized reads live in [contracts](contracts.md) and `src/db`.
For operator inspection only, bind `$owner` and `$call` in a read-only graph client:

```cypher
MATCH (c:Call {owner_id: $owner, call_id: $call})-[r]->(n)
RETURN type(r) AS relationship, labels(n) AS labels, n.ref AS ref
LIMIT 20
```

Then follow `ABOUT`, `INCLUDES`, `FOR_PACKET`, `PRODUCED`, `COMPARES`, and owner decision edges
using the recorded IDs. Graph access is an operator channel, not an authorization bypass for a
client. Public evidence reads must use the grant-enforced handlers. Preserve unknown/missing
completion and failed or unexecuted experiment arms instead of filling success values.

For every actual hosted-client/job/deployment receipt record: UTC timestamp, source commit and
dirty flag, evidence source (`hosted-client`, `local-sdk`, `runner`, `provider`), client/session/grant
IDs, call/feedback/packet/job/version/evaluation refs, expected and actual results, and redaction
notes. Link sanitized screenshots/video timestamps to those refs. Never record bearer/refresh
tokens, consent secrets, authorization codes, bypass headers, private accounts or browser sessions.
A new operator/session must reproduce the run; a working video remains pending until captured.

### Optional encrypted upstream credential custody

For upstream OAuth secrets stored in PostgreSQL with an externally supplied versioned keyring,
see [Encrypted upstream credential custody](postgres-credentials.md). Graph traces, feedback,
packets and experiments stay in FalkorDB. This optional backend binds each credential reference to
one exact deployment/resource and fences interrupted rotating-token refreshes for owner recovery.
