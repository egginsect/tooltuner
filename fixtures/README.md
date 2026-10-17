# Local MCP fixtures

Run `npx tsx fixtures/server.ts 8790` to serve real SDK Streamable HTTP endpoints on loopback.
`/textkit/v1/mcp` provides the deliberately faulty baseline. Calling `word_count` with
`{"text":"alpha  beta\ngamma"}` returns `{"count":2}`; the expected result is `{"count":3}`.
The independent `/catalog/v1/mcp` app exposes `capabilities`, returning
`{"capabilities":["json","text","unicode"]}`. Both are deterministic read-only applications.
The text fixture also offers deterministic `fail` and bounded `delay` tools for error verification.

`/textkit/example-v2/mcp` is an explicitly named corrected reference for tests and examples.
It is never seeded, activated or substituted for baseline v1. The real coding loop must create
and register its own new artifact. Public OAuth belongs to the gateway, not these local fixtures.
No inbound gateway bearer is forwarded here; configured upstream credentials are resolved separately.

`seedConfiguredFixtures(db, {owner_id, baseUrl, source:{repo_id,commit_sha}, initializeStable:true})`
in `fixtures/registry.ts` reads `config/fixtures.json`, discovers each live MCP catalog, checks its
schemas and persists v1 plus its initial stable pointer. Call it only on explicit owner configuration.
Supply the real checkout identity; the loader never guesses a commit, claims a remote deployment,
or loads production credentials. Without `initializeStable:true`, it registers only the versions.
Repeat loading at the same source/runtime is idempotent, including after restart. A changed source,
catalog or runtime cannot overwrite v1. The gateway factory never invokes this loader.

Registry composition: add `REGISTRY_INDEX_SPECS` to schema bootstrap. Use
`createGatewayCore({db, recorder, handlers})` with the real evidence service, then pass the core
to `mountGateway`. The builtin `flywheel` catalog is compiled from frozen contracts and uses
the logical version `builtin-v1`; it cannot be replaced by ordinary registrations.

Owner decision helpers live in `src/cli/versions.ts`: `activateVersion`, `rollbackVersion`,
and `recordMerge`. They take trusted local owner context, exact selected/expected version ids,
and receipts. The merge helper records an already obtained receipt; it never runs Git or activates.
These helpers are not mounted as MCP tools. Integration tests exercise them only on UUID graphs.

For the trusted jobs service, use `createPreviewRegistry({db, projects}).registerPreview` from
`src/gateway/registry.ts`. Each project config names `owner_id`, `application`, `repo_id`,
`project_id` and `team_id`. The adapter accepts `(ctx, job, packet, verification)`, validates the
manager's deployment/schema/auth receipt against those identities, and persists a deterministic
version per job without touching stable. It never imports job handlers or deploys anything.
The receipt must come from the trusted manager's fresh verification, not coding output.

`resolveAuth(reference, target)` receives the pinned owner/application/version/source/runtime
identity. Its implementation must authorize that exact credential binding before returning
server-owned headers. Redirects are rejected. A missing resolver fails before the tool is sent.

## Protected upstream linking and preview verification

`src/cli/link.ts` exports `linkUpstreamAccount(options)` for existing external credentials and
`beginUpstreamAccountLink({...options,onAuthorizationUrl})` for SDK OAuth PKCE browser consent.
Both take `{db,owner:{owner_id,subject},store,account,target,timeoutMs?}`. Account configuration
contains only `auth_config_ref`, `credential_ref`, `application`, `repo_id`, `environment`, `issuer`,
`introspection_url`, `scopes` and optional `client_id`; target configuration names the exact
`commit_sha`, `deployment_id`, `url`, `resource` and `audience`. These helpers are owner CLI only.
Already linked account references are reused across versions, never silently replaced by a new login.
Issuer identity is exact, including any trailing slash from authorization server metadata.

Compose `createCredentialMediator({db,store,timeoutMs?})`, then pass its `resolveAuth` to the
gateway. `createEnvironmentCredentialStore(environment)` reads explicit `env:VARIABLE` references
containing an `OAuthCredential` JSON document. Browser linking and resource-specific refresh require
a writable `helper:reference` via `createCredentialHelperStore({executable,homeDirectory?,timeoutMs?})`.
The helper receives JSON on stdin (`{operation:"get"|"put",reference,value?}`), returns the secret
document for get or `{stored:true}` for put, and receives no secret command arguments. Production
helpers should use an OS keychain or encrypted store. `fixtures/credential-helper.mjs` is exclusively
a local test helper with private temporary files, not a production credential store.

`createProtectedPreviewVerifier({credentials,projects,timeoutMs?}).verifyRuntime(target)` is the
jobs manager's concrete verifier. Projects configure exact owner/application/repo/project/team,
`authConfigRef`, `issuer`, `scopes` and `mcpPath`; targets come from fresh provider deployment
readback and contain `url,deploymentId,application,ownerId,repoId,commitSha,projectId,teamId` plus
optional `schemaDigest`. Only tests opt into `localOrigin`. Successful verification returns
`{tools,schema_digest,auth_config_ref,initializeVerified,authVerified,resourceVerified}` and persists
the exact approved target binding. It never calls an application tool or activates stable.

The configured issuer must support introspection, resource-specific refresh and a negative
same-origin resource probe (`/.well-known/flywheel-negative-resource/<deploymentId>`). The verifier
requires rejection of unauthenticated, invalid-token and wrong-resource requests before authenticated
SDK initialization/catalog/schema checks. Unsupported issuer capabilities fail closed; external
OAuth/Vercel verification receipts remain pending until explicitly configured and exercised.

Run `npx vitest run --config vitest.integration.config.ts tests/integration/gateway-credentials.test.ts`
against real loopback FalkorDB. All tests create UUID graphs and delete only their own graph.
`fixtures/protected.ts` supplies a real local SDK OAuth server, browser consent callback and protected
Streamable HTTP deployments. Its synthetic credentials are never used with external services.
