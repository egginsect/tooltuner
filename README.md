# ToolTuner

**An agent-facing improvement loop for MCP tools, with evidence and owner-controlled version changes in FalkorDB.**

ToolTuner connects a bad tool result to the version that produced it, the feedback explaining it,
a frozen improvement packet, a comparison, and the owner's decision. One logical `/mcp`
connection exposes exactly three outer tools: `list_apps`, `describe`, and `dispatch`.
Server-side grants separate ordinary use, development evidence access, and management operations.
This version is agent-facing; no dashboard is required.

## Actual-feedback demonstration

A real MCP SDK client called a standalone test MCP through ToolTuner with
`alpha  beta\ngamma`; its verified public baseline returned **2**. The user had previously
confirmed the expected count was **3**. This repeated repair explicitly reused that prior
confirmation, linked it to the new actual call, and froze an evidence packet.

The assistant retrieved the trace, feedback and exact repository/source pointers through MCP
before making a fresh correction in the separate test repository. PR #2 triggered a real Vercel
Preview. After live provider metadata and MCP catalog verification, the owner enrolled it as
another version of the same `textkit` application. The original client then observed
**default 2 → pinned preview 3 → default 2**. All four calls, including the initial evidence
call, have the same persisted client and session, within one retained graph and gateway.

The gateway MCP URL and client configuration stayed fixed. Candidate selection was explicit:
`dispatch.version` selected the enrolled preview; omitting it continued to resolve stable.
Candidate enrollment did not change stable. This is an **assistant-driven SDK workflow**:
the assistant authored the PR externally. Owner enrollment records the source and parent
version; the PR/deployment link is external evidence, not a claimed packet-to-candidate edge.

See [the actual-feedback guide](docs/hackathon-demo.md),
[the sanitized workflow](docs/demo-evidence/actual-feedback-workflow.json), and
[actual graph lineage](docs/demo-evidence/actual-feedback-graph.json).
The deterministic `npm run demo:local` uses a prewritten reference candidate and is a separate
framework smoke test. The latest video renders two genuine terminal-event recordings: a fresh
`describe(version)` and same-client **2 → 3 → 2** routing run, followed by read-only Cypher
queries against a verified restored snapshot of the earlier same-graph workflow. It is not a
desktop screencast. Earlier captioned slide videos are sanitized output replays.

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
