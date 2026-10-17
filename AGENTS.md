# AGENTS.md

MCP Flywheel TS (Graph Hacks demo, Linear project P-TOO-6): one TypeScript process in front of
MCP applications, with FalkorDB as the single persistent shared state. The public MCP surface is
fixed to `list_apps`, `describe` and `dispatch`. This file is the entry point for every coding
agent working in this repository (`CLAUDE.md` points here).

## Language rule (confirmed owner requirement)

Use English for all authored repository content: identifiers and filenames, code comments and
docstrings, README and other documentation, contributor/agent instructions, examples and demo
text, and user-facing CLI/API messages and errors. Write commit messages, PR titles, and PR
descriptions in English. Translate planning material into English when creating repository
artifacts. Check this convention when preparing the delivery package.

## Commands

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependencies (Node 24, see `.nvmrc`). |
| `docker compose up -d falkordb` | Start the local FalkorDB (named volume `falkordb-data`, loopback only). |
| `npm run typecheck` | `tsc --noEmit`, strict. Must pass before every commit. |
| `npm test` | Unit tests. No database, no network. |
| `npm run test:integration` | Integration tests against a real FalkorDB at `FALKORDB_URL` (throwaway graph per run). |
| `npm start` | Boot the server (`tsx src/server.ts`): config, FalkorDB, schema bootstrap, HTTP, readiness report. |
| `npm run dev` | Same with restart on file changes. |

Verify the server: `curl localhost:${PORT:-8787}/healthz` returns `{"status":"ok",...}` and HTTP 503
with a `storage_unavailable` error body when FalkorDB is down. There is no CI and no
auto-generated test suite in this project; run the commands above and record real results.

## Stack pins

Node 24, ESM (`"type": "module"`), TypeScript strict with `NodeNext` resolution (relative imports
end in `.js`), `express@5`, `zod@4` (use `z.toJSONSchema`), `@modelcontextprotocol/sdk` (OAuth
express auth router and Streamable HTTP transport), official `falkordb` client, `vitest`, `tsx`.
`package.json` and `package-lock.json` have one owner (the scaffold, TOO-66): adding a dependency is
allowed when a ticket needs it, but keep the change minimal, commit the lockfile with it, and say
why in the PR.

## Module ownership

| Path | Owner | Notes |
| --- | --- | --- |
| `src/server.ts`, `src/app.ts`, `src/config.ts`, `src/readiness.ts`, `src/lifecycle.ts`, `src/log.ts`, `src/errors.ts`, `src/db/client.ts`, `src/db/schema.ts` | Scaffold (TOO-66) | Composition root, config, health, storage client, index bootstrap. Keep changes small. |
| `src/contracts.ts`, `docs/contracts.md`, `docs/decisions.md` | Lead (TOO-63, TOO-65) | The only record/API/error schema source. Do not define a second payload shape elsewhere. |
| `src/db/<record>.ts` repository files | The ticket that needs the record (TOO-64, 67, 68, 69, 70, 78) | Small explicit functions that take a `GraphClient` and domain records. Register their indexes in `INDEX_SPECS` (`src/db/schema.ts`). |
| `src/gateway/oauth/**`, `src/gateway/policy.ts`, `src/gateway/mcp.ts` | Lead (TOO-77) | OAuth authorization server, bearer auth, grant enforcement, outer MCP tools. |
| `src/gateway/registry.ts`, `src/gateway/dispatch.ts`, `src/gateway/upstream.ts`, `fixtures/**` | TOO-64 + TOO-69 | Applications, versions, stable pointer, resolve/pin, upstream calls, fixture apps. |
| `src/flywheel/**` | One file group per ticket | Evidence store and lineage (TOO-67), feedback and packets (TOO-68), jobs and previews (TOO-78), experiments (TOO-70). |
| `tests/unit/**`, `tests/integration/**` | Whoever changes the code under test | Unit: no DB. Integration: real FalkorDB. |

### The gateway/flywheel seam

- `src/gateway/**` and `src/flywheel/**` never import each other. Both depend on
  `src/contracts.ts` (types, schemas, and the `CallRecorder`, `FlywheelHandlers` and `OperationContext` seams) and on `src/db/**`.
- The flywheel module implements `CallRecorder` and `FlywheelHandlers`; `src/server.ts` passes them
  to the gateway, which mounts operations per grant using `FLYWHEEL_OPERATIONS[op].group`. Authorization is enforced in server code at
  both discovery (`list_apps`, `describe`) and `dispatch`, never by hiding tools alone.
- `src/server.ts` is the composition root. New modules attach through `createApp({ mounts })` and
  receive `config`, `db` (a `GraphClient`) and `lifecycle` as explicit arguments. No globals, no
  hidden singletons.
- Until a worker implements its folder, `src/gateway/index.ts` and `src/flywheel/index.ts` are
  empty (`export {}`) and nothing is mounted.

## Conventions

- Prefer composition and dependency injection; pass dependencies explicitly. Small modules, no
  plugin frameworks, no second database, no scheduler.
- Cypher lives only in `src/db/**`, always parameterized through `GraphClient.query/roQuery`.
  Never interpolate values into query text. Labels and property names come from fixed code.
- Fail with descriptive errors that say what to do next. Never fall back to in-memory storage or
  invent a success: a failed write is an error, a timed-out write has an unknown outcome.
- Config comes from environment variables validated in `src/config.ts`. A new variable needs a
  zod entry, a line in `.env.example`, and (for optional features) a readiness item.
- Secrets: never commit them, never print them. Config and logs show presence only. Do not copy
  `.env*` files or deployment state between checkouts. The trusted manager's credentials (Vercel,
  management grant) and the owner's merge/activation credentials must never be inherited by a
  coding subprocess: spawn subprocesses with an explicit allowlisted environment, never
  `process.env`.
- Logging goes to stderr (stdout stays clean for stdio transports).
- Git: work on a topic branch, stage explicit paths, deliver through a PR. Never use `--no-verify`.
  Keep the repository private; the Apache-2.0 license is a proposal until the owner decides.
