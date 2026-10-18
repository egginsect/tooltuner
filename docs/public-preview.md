# Explicit public preview enrollment

This owner-only route adds a publicly reachable, anonymous Vercel preview as a new immutable version of an existing application. It does not deploy code, change Vercel access settings, obtain a token, create a Job, change grants, or activate STABLE. Protected upstream enrollment and the protected automatic preview manager remain separate and unchanged.

Use this only for an intentionally public preview containing no private upstream capabilities or data. Public deployment access means anyone with the endpoint may call it outside ToolTuner; ToolTuner's own grants do not protect that external endpoint.

## Required evidence

- An existing exact parent version under the same owner, application and source repository
- The full source commit, provider deployment ID, existing project and team IDs
- The provider-returned immutable deployment endpoint, never a production/branch/custom alias
- An explicit `auth_mode: "none"` and selected tool-name subset
- A previously authenticated Vercel CLI with read access to that project

The command reads deployment and project metadata live through fixed read-only Vercel API routes. It checks READY, preview target, team/project identity, linked GitHub repository and exact source. For Git deployments it checks the provider's Git source and commit metadata. For CLI uploads it requires `tooltunerRepoId` and `tooltunerCommitSha` metadata on an upload with no Git source; these are recorded honestly as owner-provided source assertions, not a provider Git build attestation. Upload only an archive of the exact committed source. Never fabricate these metadata values to make verification pass.

No arbitrary JSON receipt replaces provider readback. The live MCP initialize/listTools handshake must succeed anonymously, selected tools must exist, and their schemas are captured. No business tool is called by enrollment. A protected endpoint that demands authentication fails; there is no token or bypass fallback.

## Command

Prepare a nonsecret JSON file:

```json
{
  "application": "sample",
  "description": "Sample application",
  "label": "preview-2",
  "source": { "repo_id": "sample/demo", "commit_sha": "<40-character-source-commit>" },
  "parent_version_id": "<exact-existing-version-id>",
  "url": "https://<immutable-deployment>.vercel.app/mcp",
  "deployment_id": "dpl_example",
  "project_id": "prj_example",
  "team_id": "team_example",
  "auth_mode": "none",
  "network_policy": "provider_verified_vercel",
  "tools": ["count_words"]
}
```

Run the trusted local owner CLI with the existing Vercel executable and its explicitly selected runtime directories:

```sh
npm run owner -- application enroll-public-preview \
  --input public-preview.json --subject owner \
  --vercel-cli /absolute/path/to/vercel \
  --vercel-data /absolute/path/to/existing-cli-data \
  --vercel-cache /absolute/path/to/cli-cache
```

The command uses an allowlisted child environment and never reads or prints Vercel authentication files. If login is unavailable, perform the normal supported CLI login separately; this command will not authenticate automatically. `TOOLTUNER_OWNER_ID` selects the trusted administrative owner namespace. Do not run this command from the hosted gateway or install deployment credentials there.

The result returns the new version ID and `stable_changed: false`. Pin that version explicitly through `dispatch` to compare it with the parent. Changing STABLE remains a separate owner decision.

## Honest readiness and network boundary

New public versions have a digest-bound `public_access` policy and `auth_verified: false`. Readiness accepts that narrowly defined anonymous policy only for owner-configured Vercel previews with no credential reference or managed Job/Packet assertion. Older version digests and protected authentication requirements are unchanged.

Both discovery and later dispatch use the same explicit, digest-bound network policy. No automatic fallback occurs:

- `public_ipv4_pinned` resolves public IPv4 addresses at socket connection time and passes a verified address directly to TLS while retaining hostname certificate verification. Private, reserved, mixed public/private and IPv6-only DNS results fail closed. It requires a runtime with supported direct DNS/network access.
- `provider_verified_vercel` uses standard TLS fetch through the runtime's supported trusted environment proxy when configured. It trusts Vercel's DNS/TLS and that configured proxy for the live-provider-verified immutable single-label `*.vercel.app` endpoint. It does not claim socket DNS pinning or private-address inspection behind the proxy. Arbitrary public HTTPS hosts, aliases, endpoint changes and redirects remain unsupported. Select this policy explicitly; never use it as a silent response to a denied network request.

Both modes permit only the exact verified endpoint and reject credentials or unapproved headers. Requests and responses are incrementally bounded; deadlines begin before request-body consumption, and aborts/cancellation terminate streams. Only MCP protocol headers are allowed. No inbound bearer, Vercel token, cookie, or deployment bypass credential is attached. Supported proxy trust configuration retains normal TLS verification; never disable certificate checks.

The owner CLI forwards only named trusted proxy settings (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`, `NODE_EXTRA_CA_CERTS`) alongside its explicit runtime directories and executable path to the provider-read subprocess. It does not forward the entire operator environment.

This wiring is not evidence that feedback caused a code change. A genuine demo must separately record the real call, the user's actual feedback, the resulting evidence/packet, the actual code change and committed deployment, then enroll and call that new version. Manual assistant coding is not a fabricated automated Job.
