# ToolTuner

**An agent-facing improvement loop for MCP tools, with evidence and owner-controlled version changes stored in FalkorDB.**

Agents can call tools, but a bad result is often detached from the version that produced it, the feedback explaining it, and the decision to ship a fix. ToolTuner keeps those relationships together. One MCP connection exposes three outer tools: `list_apps`, `describe`, and `dispatch`. Behind them, grants separate ordinary use, development evidence access, and management operations.

## Working demo

Submission target: **Agent Memory and Coordination**. The graph preserves tool-use evidence across
service sessions and supports scoped handoffs between user, development, and management roles.
The demonstrated clients are SDK clients; an autonomous LLM coding loop is not shown.

The local demonstration runs real MCP SDK transports, the production gateway composition, and real FalkorDB. It uses synthetic read-only fixtures; no external account or cloud deployment is required.

For `alpha  beta\ngamma`, a faulty word-count tool returns **2**. The same SDK client pins a prewritten corrected candidate and gets **3**, then calls the default again and still gets **2**. Feedback is attached to the failed call and frozen into a digest-checked improvement packet. A deterministic comparison reports baseline **fail** and candidate **pass**. A separate owner action activates the candidate; the same client now gets **3** by default. Rollback restores **2**. All MCP grants are denied activation and rollback.

The run also checks durable evidence, refreshed-token calls, storage-unavailable health responses, independent-process readback, and a real service stop/restart with existing tokens and evidence. The database stays running during service restart; this is not a database crash-recovery claim.

The corrected candidate is a **prewritten fixture**, not an autonomously generated patch. The demo does not launch a coding agent or deploy a hosted preview.

## Reproduce locally

Prerequisites: Git, Node 24, npm, Docker with Docker Compose, and a running Docker engine. Run from the repository root:

```sh
npm ci
npm run demo:local
```

The launcher starts the supplied FalkorDB container on loopback, waits for readiness, runs the exercise, and removes only its disposable UUID graph. The database container remains running. No `.env` file is loaded by the demo.

For an existing local FalkorDB instead:

```sh
FALKORDB_URL=redis://127.0.0.1:6379 npm run --silent demo > demo-receipt.json
```

Use separate `FALKORDB_USERNAME` and `FALKORDB_PASSWORD` environment variables if required; do not put secrets in recorded commands or URLs. The database must permit creation and deletion of a disposable graph.

Additional checks:

```sh
npm run typecheck
npm test
FALKORDB_URL=redis://127.0.0.1:6379 npm run test:integration -- tests/integration/runtime.test.ts
```

A successful demo emits a JSON receipt and exits zero. Assertion failure exits nonzero. Receipt references identify records checked before disposable-graph cleanup; they are not persistent public links. See `docs/local-demo.md` for complete setup, cleanup, and limitations. No dashboard is required: this version is designed for agents and a local owner CLI.

## Why FalkorDB is central

FalkorDB stores the application/version registry, stable pointer, OAuth state, call/evidence lineage, feedback, frozen packets, evaluations, and owner decisions. It is not an optional visualization or cache. The gateway checks real storage health, and writes are acknowledged only after persistence.

### Graph model

- `Application -[:HAS_VERSION]-> Version`; `Application -[:STABLE]-> Version`
- `Version -[:DERIVED_FROM]-> Version`
- `Call -[:RESOLVED]-> Version`; `Call -[:INPUT|OUTPUT]-> Evidence`
- `Call -[:HAS_EVENT]-> CallEvent`; `Call -[:CAUSED_BY]-> Call`
- `Feedback -[:ABOUT]-> Call`; `Feedback -[:TEXT]-> Evidence`
- `Packet -[:INCLUDES]-> Call / Feedback / Evidence`; `Packet -[:BASED_ON]-> Version`
- `Packet -[:SUCCESSOR_OF]-> Packet`
- `Evaluation -[:COMPARES]-> Version`; `Evaluation -[:RAN]-> Call`
- `Recommendation -[:FROM]-> Evaluation`; `Recommendation -[:RECOMMENDS]-> Version`
- `HumanDecision -[:SELECTED]-> Version`; `HumanDecision -[:EXPECTED_CURRENT]-> Version`

Job/preview records are also modeled, but an external coding-runner/hosted-preview workflow is outside this demonstration.

### Graph-dependent queries and operations

Cypher is parameterized in `src/db/`. `src/db/evidence.ts` implements bounded lineage traversal over the evidence graph (up to six hops), with owner, application, repository, tool, version, and packet-scope checks along each path. Frozen packets store both their content/digest and graph links to the baseline and included records. `src/db/experiments.ts` links comparisons to versions and the exact calls that produced their results. `src/db/registry.ts` changes the stable edge and records the owner decision in one guarded query; an unexpected current version rejects the stale decision.

Read-only inspection examples below use parameters, not interpolated values. They are explanatory operator queries; production authorization is enforced by the repository functions and grant policy.

```cypher
// Recover the version, feedback, and frozen packet behind a call.
MATCH (c:Call {owner_id:$owner, call_id:$call})-[:RESOLVED]->(v:Version)
OPTIONAL MATCH (f:Feedback {owner_id:$owner})-[:ABOUT]->(c)
OPTIONAL MATCH (p:Packet {owner_id:$owner})-[:INCLUDES]->(c)
RETURN c.call_id, v.version_id, f.feedback_id, p.packet_id, p.digest
```

```cypher
// Find the exact version and calls behind a comparison.
MATCH (e:Evaluation {owner_id:$owner, evaluation_id:$evaluation})-[:COMPARES]->(v:Version)
OPTIONAL MATCH (e)-[:RAN]->(c:Call {owner_id:$owner})
RETURN e.evaluation_id, v.version_id, c.call_id, c.resolved_version
```

```cypher
// Inspect the owner's decision history alongside the current stable version.
MATCH (a:Application {owner_id:$owner, application:$application})-[:STABLE]->(stable:Version)
MATCH (d:HumanDecision {owner_id:$owner, application:$application})-[:SELECTED]->(selected:Version)
OPTIONAL MATCH (d)-[:EXPECTED_CURRENT]->(previous:Version)
RETURN stable.version_id, d.decision_id, selected.version_id, previous.version_id
ORDER BY d.created_at
```

No graph algorithm such as PageRank or community detection is claimed. The graph work is relationship traversal, provenance, constrained evidence retrieval, and guarded state transition.

## Implementation

TypeScript, Node.js, Express, the official MCP SDK, and the official FalkorDB client. Optional PostgreSQL provides encrypted upstream credential custody; it is not used as the graph store and is unnecessary for the anonymous local fixtures. Supabase sign-in/RLS integration is separate from this recording; live provider onboarding is not demonstrated here.

## Verification and limits

The included public `demo-receipt.json` summarizes a real run: timestamp, passed assertions, output values, and semantically labeled synthetic references. `graph-query-results.json` includes the actual read-only queries and returned rows with the same consistent labels. Runtime graph identifiers and source hashes are omitted from these public summaries; the original receipts are retained separately. The tracked source tree matched the reviewed branding candidate, with only an untracked dependency symlink. Full-suite status is documented separately; a passing demo is not a claim that every integration test passed.

Not demonstrated: hosted ChatGPT/Claude onboarding, autonomous patch generation, a hosted preview, production activation, or production scale/performance. There are no invented speed, cost, accuracy, or adoption metrics.

## AI-assistance disclosure

AI assistants helped implement code, tests, fixtures, and documentation. The project entrant is responsible for understanding and explaining the code, architecture, security boundaries, and demonstrated results. The demonstrated candidate is a prewritten reference fixture.
