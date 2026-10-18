# ToolTuner

**An agent-facing improvement loop for MCP tools, with evidence and owner-controlled version changes in FalkorDB.**

ToolTuner connects a bad tool result to the version that produced it, the feedback explaining it,
a frozen improvement packet, a comparison, and the owner's decision. One logical `/mcp`
connection exposes exactly three outer tools: `list_apps`, `describe`, and `dispatch`.
Server-side grants separate ordinary use, development evidence access, and management operations.
This version is agent-facing; no dashboard is required.

## Hackathon demo

Submission target: **Agent Memory and Coordination**, for durable evidence and scoped handoffs
between agent roles. The demonstration uses SDK clients, not an autonomous LLM coding loop.

The reproducible local demo uses real MCP SDK transports, the production gateway composition,
and real FalkorDB with synthetic read-only fixtures. One client observes a faulty word count of
**2**, a pinned corrected candidate of **3**, and an unchanged default of **2**. Feedback and a
frozen packet preserve the reproduction. A deterministic comparison reports baseline **fail**
and candidate **pass**. Separate owner activation changes the same client's default to **3**;
rollback restores **2**. The run also verifies evidence readback from an independent process
and production-service restart with existing tokens. The database stays running during that check.

The candidate is **prewritten**, not generated autonomously during the demo. A successful local
run does not establish hosted ChatGPT/Claude compatibility, a coding-agent job, a hosted preview,
or production activation. See the [submission guide](docs/hackathon-demo.md) for the complete
walkthrough, Cypher examples, evidence interpretation, and limitations.

## FalkorDB graph model and operations

FalkorDB is required persistent state, not a visualization add-on:

- `Application -[:HAS_VERSION|STABLE]-> Version`
- `Call -[:RESOLVED]-> Version`; `Call -[:INPUT|OUTPUT]-> Evidence`
- `Feedback -[:ABOUT]-> Call`; `Feedback -[:TEXT]-> Evidence`
- `Packet -[:INCLUDES]-> Call / Feedback / Evidence`; `Packet -[:BASED_ON]-> Version`
- `Evaluation -[:COMPARES]-> Version`; `Evaluation -[:RAN]-> Call`
- `HumanDecision -[:SELECTED|EXPECTED_CURRENT]-> Version`

Parameterized Cypher in `src/db/evidence.ts` retrieves bounded lineage (up to six hops), checks
access scope along paths, and links digest-checked frozen packets to their exact baseline and
evidence. `src/db/experiments.ts` links comparisons to versions and execution calls.
`src/db/registry.ts` updates the stable edge and records the owner decision in one guarded query;
a stale expected-current version is rejected. No PageRank or other graph-ranking algorithm is
claimed. The graph operations are provenance traversal, constrained retrieval, and guarded state
transition. The [submission guide](docs/hackathon-demo.md) includes runnable parameterized
read-only Cypher examples; [contracts](docs/contracts.md) describe the complete schema.

## Install and reproduce locally

Use Node 24 (`.nvmrc`), npm, Git, and a real FalkorDB. Docker Compose is supplied; an existing
loopback FalkorDB may be used instead. Linux bubblewrap and a configured coding CLI are required
only for isolated coding jobs. A manager needs an already existing Vercel account and project
for previews; no new project or production deployment is part of this setup.

```sh
npm ci
docker compose up -d falkordb
npm run typecheck
npm test
npm run test:integration
npm run demo
```

For a one-command local demonstration, run `npm run demo:local` (Node 24 and Docker Compose
required; it installs dependencies if absent and waits for real FalkorDB). Or set `FALKORDB_URL`
to use an existing database. See the [five-minute walkthrough](docs/local-demo.md).

`npm run demo` starts real local MCP fixtures and the production service composition, enrolls
stable/candidate versions, performs OAuth and same-client routing, records traces/feedback/a
frozen packet, and compares the faulty baseline with a prewritten corrected candidate. Separate
owner activation and rollback change the same client's default from 2 to 3 and back to 2. It
checks grant denials, refresh, storage recovery and independent-process persistence readback.
The UUID graph is deleted afterward. The receipt labels source commit and dirty checkout status;
a dirty run is not committed artifact provenance. No coding job or deployment is launched.

`npm run test:integration` also uses owned UUID graphs. Set `FALKORDB_URL` if the database is
elsewhere; use separate `FALKORDB_USERNAME` and `FALKORDB_PASSWORD` variables for credentials.
Commands require local network access. There is no build command or CI requirement: `tsx`
executes the ESM TypeScript sources, and `npm run typecheck` checks them without emitting files.

## Run the service

```sh
npm start
curl --fail http://127.0.0.1:8787/healthz
```

Defaults are loopback port 8787 and graph `flywheel`. `SIGINT`/`SIGTERM` close admission, drain
the HTTP listener, and close storage. `/healthz` checks the real schema/storage; a storage failure
or draining process returns 503. A healthy database alone does not mean OAuth, upstream linking,
jobs, or previews are configured. Read the startup readiness report.

Configuration uses `TOOLTUNER_*` keys documented in [.env.example](.env.example).
See [configuration migration and automatic Vercel origins](docs/configuration.md). Supply secrets from the
operator's credential environment; never copy credentials or deployment state between checkouts.
The process does not automatically load `.env` files. With no public origin and owner consent
secret it serves health only. Follow the [operator runbook](docs/demo.md) to register fixtures,
create grants, expose the complete OAuth origin and capture actual client receipts.

## Hosted gateway preparation

The request-only Vercel Node entry is `api/index.ts`; `vercel.json` routes the complete origin
to it. It reuses the gateway composition without starting a listener or local coding jobs.
See [Vercel gateway setup and verification](docs/vercel-gateway.md) for required external
storage, secret injection, stable-origin OAuth, and the deployment checks still required.
This configuration does not create a project or deploy anything.

## Architecture and review

### Interactive architecture diagram

Download [the standalone HTML diagram](docs/architecture.html) and open it in a browser;
GitHub's source viewer does not run the interactive page. It works offline.
The [editable Archify JSON](docs/architecture.json) is included alongside it.

This source-based overview distinguishes the request-only hosted gateway from optional local
workers. Transaction-pooler credential refresh is implemented and tested in the review PR
stack, not a claim of merged main or live rollout. The architecture snapshot predates the Supabase login implementation described below; live provider setup remains pending.
Schema, layout and artifact checks passed; browser visual review was blocked by the execution
environment. The diagram contains no private deployment endpoints or upstream identities.

`src/server.ts` owns process signals and startup reporting; `src/runtime.ts` composes the real
services and all module indexes. Gateway and flywheel modules share contracts and grant policy,
without importing each other. Cypher stays in `src/db`; writes are acknowledged only after
persistence. An admitted call without a durable completion remains unknown.

The faulty `textkit` v1 and independent read-only `catalog` are synthetic technical fixtures.
`textkit/example-v2` is a corrected reference used by tests, not a real coding-job artifact.
Previews and recommendations never change stable. Only the local owner control channel can
record merge, activate, or rollback decisions, with exact version and expected-current checks.

- [Frozen contracts and graph model](docs/contracts.md)
- [Decisions and ordered delivery gates](docs/decisions.md)
- [Runbook, grant matrix, recording and handoff](docs/demo.md)
- [Actual checks, limitations and publication readiness](docs/verification.md)

AI assistants helped implement code, tests, fixtures, and documentation; the project entrant remains responsible
for architecture, security, correctness, and explaining the result.

Optional upstream OAuth custody: [PostgreSQL encryption, exact-target bindings and refresh recovery](docs/postgres-credentials.md).

For protected MCP servers without token introspection, see [standard OAuth owner linking](docs/standard-oauth.md) for explicit PKCE/device acquisition, encrypted custody and selected-tool remote enrollment.


## Multiuser sign-in

[Supabase Auth integration](docs/supabase-auth.md) adds email/password and Google login for existing accounts, with each verified UUID owning separate grants and data. The existing MCP authorization server still enforces explicit grant consent. [Credential RLS](docs/credential-rls.md) describes the required backend-only database role and policies; Supabase mode rejects an unsafe credential connection. Provider setup, migration execution and account lifecycle synchronization are separate operational work.
