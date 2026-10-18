# Decisions and delivery gates (TOO-63)

Integration status (2026-10-17): local TypeScript/SDK/FalkorDB checks are tracked in
`docs/verification.md`; the executable local exercise is `npm run demo`. The public HTTPS,
real hosted-client, coding-runner and verified preview receipts required below remain pending.
The contest's local-setup/video allowance does not replace these project acceptance gates.

The owner confirmed the following:
- Fresh TypeScript implementation, one Flywheel process, and FalkorDB as the only persistent shared state.
- The Python repository is a read-only behavior reference. Nothing is ported or copied from it.
- Flywheel core is exposed through a fixed public HTTPS tunnel at `/mcp`. Wrapped MCP apps and their previews run on Vercel.
- The owner links the upstream app or account once. Every client gets its own Flywheel grant. Switching versions never requires reconnecting.
- There are exactly three outer tools: `list_apps`, `describe` and `dispatch`. No dashboard, no widgets, no CI or automated suites are prerequisites.
- Three independently composable tool groups: user, development and management. Human merge and stable activation belong to none of them.
- A coding job gets development-only access scoped to its app, repo and packet, and works in an isolated worktree.
  - The trusted manager holds the management grant and the Vercel identity.
  - The owner's merge and activation credential lives only in the owner CLI.
  - None of these credentials are inherited by coding subprocesses.

## Implementation choices (executor defaults, open to owner review)

| Area | Choice | Reason |
|---|---|---|
| Runtime | Node 24, ESM, TypeScript strict, `tsx` | One process with no build step. |
| HTTP | express 5 | The MCP SDK auth router and Streamable HTTP transport are express-based. |
| MCP | `@modelcontextprotocol/sdk` | Maintained transport, auth metadata, DCR, PKCE and bearer middleware. |
| OAuth | Flywheel acts as its own authorization server through SDK `mcpAuthRouter`, with an owner consent page. Tokens are opaque random values whose hashes are stored in FalkorDB, bound to resource, client and grant. | Uses maintained primitives instead of a self-designed protocol. Claude and ChatGPT both require DCR and PKCE. |
| Schemas | zod v4 (`z.toJSONSchema` for `describe`) | The single source for runtime validation and published schemas. |
| Graph | `falkordb` npm client, parameterized Cypher, small domain functions | No generic graph plugin layer. |
| Tunnel | ngrok account dev domain (fixed hostname), or an existing named tunnel | Requires a stable issuer and resource across restarts. |
| Previews | Vercel CLI behind a small `deployPreview` helper | A replacement seam, not a deployment framework. |
| Coding runner | One configured coding CLI (`claude -p` or `codex exec`) behind `RunnerAdapter` | Uses the runner's own authentication. Flywheel needs no model API key. |
| Experiments | Explicit version pins, the same input, a deterministic criterion | No live A/B and no statistical winner. |

## Delivery gates (in order)

1. Contract frozen (`src/contracts.ts`).
2. Process, FalkorDB, registry, a bootstrap v1 and a fixture can be called locally (TOO-66, TOO-64, the TOO-69 bootstrap slice).
3. Real OAuth: ChatGPT and Claude connect to the fixed `/mcp`, then call `list_apps`, `describe` and `dispatch`, with per-grant catalogs (TOO-77).
4. Graph evidence: call, then feedback, then packet (TOO-67, TOO-68).
5. Real coding job, then manager deploy, then preview v2 registration (TOO-78).
6. Comparison of v1 and v2 on the same input, plus a recommendation (TOO-70).
7. Human merge decision (owner CLI).
8. Separate human stable activation, with rollback (TOO-69).

## Configuration and external readiness checklist

Secrets stay in the process credential environment or an external credential helper. Runtime JSON contains references, not credential values. Readiness reports presence, never values.

| Item | Config | Agent-runnable? |
|---|---|---|
| Public origin | `FLYWHEEL_PUBLIC_ORIGIN` (fixed tunnel hostname) | Needs the owner's ngrok (or other tunnel) account. |
| OAuth issuer, resource, redirect | Derived from `FLYWHEEL_PUBLIC_ORIGIN`. The issuer, resource (`/mcp`) and metadata must all match. | Yes |
| Owner consent | `FLYWHEEL_OWNER_SECRET` (secret environment value) | The owner sets the value. |
| FalkorDB | `FALKORDB_URL` | Yes (docker compose) |
| Allowlisted repos and base SHAs | `RUNNER_CONFIG_PATH` JSON | Yes |
| Vercel project | `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID`, `VERCEL_TOKEN` (manager only) | Needs the owner's `vercel login` or token. |
| Coding CLI runner | `RUNNER_CONFIG_PATH` allowlisted executable/config | Uses the runner's own authentication. |

## Python reference mapping (behavior only)

| Python concern | TypeScript entry point |
|---|---|
| Preflight and config | `src/config.ts`, startup readiness report |
| Database bootstrap | `src/db/` index bootstrap |
| Login and operator | `src/gateway/oauth/*` consent page and owner CLI `src/cli/owner.ts` |
| Gateway | `src/gateway/*` (outer tools, registry, dispatch) |
| Upstream registration | `FIXTURE_REGISTRY_PATH` explicit v1 seed plus `register_preview` |

PostgreSQL, OTel, Jaeger, Tempo and the packet scripts are not carried over.

## Out of scope for M1

Scheduler or durable work queue, OAuth production hardening, sandbox or RL adapters, trace sharing or marketplace, and any second database. See TOO-71 and TOO-73 through TOO-76. The Apache-2.0 license is a proposal only and needs separate confirmation before publication.


## Additive credential custody decision (2026-10-18)

The optional PostgreSQL upstream credential adapter is an approved exception to the original
single-store/non-goal boundary above. It contains encrypted upstream OAuth documents only;
graph registry, grants, inbound token hashes, calls, feedback, packets and experiments remain in
FalkorDB. It uses Node AES-256-GCM with an external versioned keyring and exact-target identity,
plus cross-process refresh fencing and compare-and-swap. This does not migrate legacy users or
grants, copy legacy code, implement a KMS envelope system or claim production readiness.
See [configuration, recovery and operational limits](postgres-credentials.md).
