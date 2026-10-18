# MCP Flywheel TS

A TypeScript MCP gateway with FalkorDB for graph state and optional PostgreSQL for encrypted upstream credentials. Clients keep one
logical `/mcp` connection and use exactly three outer tools: `list_apps`, `describe`, and
`dispatch`. Server-side grants independently compose user, development, and management tools.
The graph connects calls, evidence, feedback, frozen improvement packets, jobs, immutable
versions, comparisons, recommendations, and separate owner decisions.

This is a private M0/M1 implementation in preparation for review. Local checks are described
in [verification](docs/verification.md). Real ChatGPT/Claude onboarding, public HTTPS, actual
coding-runner/deployment receipts, and the complete M1 recording remain pending. Local SDK
evidence does not establish hosted-client compatibility or a completed M1 demo.

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

Configuration keys are documented in [.env.example](.env.example). Supply secrets from the
operator's credential environment; never copy credentials or deployment state between checkouts.
The process does not automatically load `.env` files. With no public origin and owner consent
secret it serves health only. Follow the [operator runbook](docs/demo.md) to register fixtures,
create grants, expose the complete OAuth origin and capture actual client receipts.

## Architecture and review

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

AI assistants helped implement code, fixtures, and documentation; the owner remains responsible
for architecture, security, correctness, and explaining the result. Apache-2.0 is a proposal
pending owner approval. The repository remains private; publication and contest submission are
not authorized by this preparation.

Optional upstream OAuth custody: [PostgreSQL encryption, exact-target bindings and refresh recovery](docs/postgres-credentials.md).
