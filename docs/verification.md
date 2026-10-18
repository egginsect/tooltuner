# Verification and delivery readiness

This page records historical local checks from 2026-10-17. It is not a certification of the current branch or a substitute for rerunning its tests. It excludes private service identifiers and generated receipt details.

## Evidence ledger

This ledger distinguishes code/DB/SDK checks from real hosted-client and provider receipts.
Full M1 acceptance is pending. No screenshots, video, public-client login or Vercel receipt is
fabricated or inferred from unit tests. No full integrated adversarial/security audit was completed.

| Check | Actual state |
|---|---|
| Node | Node 24.21.0 observed locally on 2026-10-17 |
| Locked installation | Existing local dependencies available; Passed fresh isolated offline install (158 packages); fresh tsx transform also passed |
| Typecheck | Lead full-source check passed at 22:14 UTC; every exact committed layer also passed typecheck |
| Auth/config units | Included in the final 60 passing unit checks across six files |
| OAuth integration | Included in the final 93 passing real integration checks across nine files; focused lead OAuth regressions also accepted |
| Runtime composition smoke | Five production-runtime checks passed at 22:13 UTC, including real owner CLI linking and configured protected upstream mediation |
| Public HTTPS discovery and instance match | Pending fixed hostname and tunnel/account |
| ChatGPT and Claude OAuth, catalogs, calls, refresh/reconnect | Pending owner account login and consent |
| Upstream owner account linking/authenticated preview mediation | Concrete owner CLI, credential mediation and protected verifier wired; configured account/helper and actual account evidence pending |
| Coding CLI job/isolation/start receipt | Tests ran real bubblewrap and a Node child on this host; an actual authenticated coding CLI receipt remains unverified |
| Existing-project Vercel verified preview/registration | Concrete manager/verifier/registry wired; configured existing account/project/helper credentials and actual preview receipts pending; no production or new-project action |
| Exact pinned baseline/candidate experiment and recommendation | Pending real job-produced candidate |
| Human merge/activation/rollback | Not authorized or performed; separate operator decisions |
| Video/screenshots and fresh-operator reproduction | Pending actual recording and independent replay |

Local smoke graph IDs are UUID-scoped and deleted after the run. Receipts can identify the IDs
but cannot claim continued readback after cleanup. The smoke verifies persistent records by
closing the DB connection and composing fresh services before deleting the graph. Process-level
signal shutdown is tracked separately from an in-process drain probe.

## Capability limits

The service can run local health/storage checks without external integrations. OAuth is mounted
when a valid origin/resource and owner consent secret are supplied; grants must be created
explicitly. Operations without configured adapters are hidden/unavailable. A claimed ready preview
requires actual trusted verification; a local fixture or mocked provider is not a deployment.
The single-process job runner has no persistent scheduler or automatic recovery guarantee.
Unknown starts/completions require reconciliation. M2 lifecycle/tenant hardening remains outside
the M1 scope; auth and data isolation required by M1 are still mandatory.

## Provenance, licenses and publication

Fixtures and reproduction text are synthetic technical examples authored for this TypeScript
implementation. The corrected reference fixture is a test aid, not an autonomous repair receipt.
No source from the Python behavior-reference repository is copied. AI assistants contributed
implementation, review and documentation; the owner is responsible for explaining and validating
the architecture, security and correctness.

The [official Graph Hacks FAQ](https://www.wemakedevs.org/hackathons/falkordb), checked 2026-10-17,
allows coding assistants with owner responsibility. It requires FalkorDB to be central; it prefers
a live deployment and otherwise requires complete local setup plus a working video. Its closing
time is 2026-10-18 23:59 IST (18:29 UTC). Those contest allowances do not relax this project's
stricter actual public OAuth, hosted-client and preview receipt requirements. Confirm the current contest rules directly before submission.

| Item | State |
|---|---|
| Repository visibility | Verify the intended release state with the repository owner |
| Project license | Confirm the repository license and preserve required notices before distribution |
| Third-party dependencies | Pinned by `package-lock.json`; 227 package entries all contain declared license metadata; rights/notice review pending |
| Direct runtime packages | MCP SDK, ajv, ajv-formats, Express, express-rate-limit, FalkorDB client, zod |
| Development packages | TypeScript, tsx, Vitest, Node/Express types |
| Fixture/media rights | Synthetic fixtures; inspect captured media for account/third-party rights before release |
| Sensitive material | `.env*`, deployment state, tokens, PII and browser sessions excluded; inspect any receipt before sharing |
| Publication/marketplace/contest | Review the release contents and obtain the repository owner’s approval |

## Local integration results (2026-10-17)

The lead ran the whole suite from 22:14:00 to 22:14:24.52 UTC:

- `npm run typecheck`: passed.
- `npm test`: 60 checks passed across six files on that source snapshot.
- `npm run test:integration`: 93 checks passed across nine files (24.52 seconds) on that source snapshot.
- `git diff --check`: passed.
- The runtime file contains five passing integration checks: real two-step owner OAuth/SDK/FalkorDB; MANAGEMENT-only frozen trials with direct upstream/raw-read denials and unchanged persisted grant; a real owner CLI synthetic account link followed by a configured protected upstream call; a separate server process and SIGTERM; and coding credential/configuration boundaries.

Tests ran real bubblewrap and a Node child on this host. That proves the exercised local isolation/start path; an actual authenticated coding CLI and a real job-produced deployment remain unverified. Credential-helper tests used synthetic local OAuth accounts, never real provider credentials. The prior fresh isolated offline locked install succeeded with 158 packages and a working tsx transform; npm's existing install-script approval policy was not bypassed.

The historical credential-free standalone demo verified persisted readback through fresh service composition before deleting its temporary UUID-scoped graph. It is local SDK evidence, not provider or hosted-client provenance. Generated receipt identifiers and checkout metadata are intentionally omitted from this public summary.

The demo exercised authenticated grant selection without unauthenticated metadata disclosure, four group catalogs and direct-call denials, exact v1 pin and missing-version failure, idempotent replay, durable feedback/packet ACK, scoped reads with outside-packet and nonexistent refs hidden identically, refresh, the second app, storage-disconnect 503, persisted records/tokens after fresh composition, and drain health.

The earlier 21:43 passing suite was superseded by regression corrections for consent/callback handling, concurrent admission, frozen lineage and MANAGEMENT-only trials. Auth/evidence independent regressions and focused final binding/replay guard inspection were accepted by the lead. No full integrated adversarial/security audit was completed.

At 22:10:01 UTC, the existing FalkorDB 4.22.1 / Redis 8.10.2 container exited 139 after native SIGSEGV; it was not OOM-killed. The native stack showed indexer activity; root cause remains unestablished. The same container restarted at 22:11 on the unchanged named volume, with no reset. Subsequent runtime checks and the final 93-check integration run passed. The interrupted four-test run is recorded as failed and does not count as acceptance.

The gateway worker saved a final account-conflict/callback guard delta and three corresponding test assertions at 22:14:39 UTC, after that whole-suite run. The lead reviewed and accepted this delta, then independently passed all 11 `gateway-credentials` checks on the committed final linking code at 22:19:27 UTC (5.47 seconds). The 93-check whole-suite result does not claim to include the later edit. Every delivery layer passed typecheck on its exact dependency-correct staged source before its commit. External gates in the ledger remain pending; no local assertion substitutes for hosted-client, authenticated coding CLI or provider receipts.

## Dependency license inventory

The lockfile supplies package names, exact versions and declared licenses for all 227 entries,
including optional platform packages. Counts are metadata declarations, not a legal clearance:
MIT 177, Apache-2.0 25, MPL-2.0 12, ISC 9, BSD-3-Clause 3, BSD-2-Clause 1.
`package-lock.json` is the complete transitive inventory; preserve upstream notices before release.
The external FalkorDB server/container and coding/Vercel/tunnel tools need their own rights and
terms review; their licenses are not inferred from the npm client package.

| Direct package | Locked version | Declared license |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |
| `ajv` | 8.20.0 | MIT |
| `ajv-formats` | 3.0.1 | MIT |
| `express` | 5.3.0 | MIT |
| `express-rate-limit` | 8.7.1 | MIT |
| `falkordb` | 6.8.0 | MIT |
| `zod` | 4.6.7 | MIT |
| `@types/express` | 5.0.6 | MIT |
| `@types/node` | 24.19.2 | MIT |
| `tsx` | 4.23.15 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `vitest` | 5.0.5 | MIT |


## Delivery and interpretation

The earlier foundation checks included a clean-environment offline locked install, typecheck, unit tests and UUID-scoped graph integration checks. Those historical checks apply to the tested source snapshot; they do not establish that later changes passed the same suite.

For the current checkout, follow the documented setup and rerun the relevant checks. Review the Auth and credential-isolation documentation for their specific validation requirements. Local or synthetic tests do not establish successful hosted-client consent, authenticated provider access, or deployment receipts. Review all publication material for credentials, account identifiers and private service details before sharing.
