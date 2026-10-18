# ToolTuner: actual feedback to a callable preview

Submission target: **Agent Memory and Coordination**.

ToolTuner is an agent-facing MCP gateway. It connects tool calls to their exact versions,
feedback, frozen evidence packets, and owner-controlled version registration. FalkorDB is the
persistent graph behind those relationships, not an optional diagram.

## What actually happened

1. The standalone test MCP was deployed from its own repository through a genuine Git-triggered
   Vercel Preview. Its source and catalog were verified before owner enrollment. A separate owner decision then made it the
   initial public stable version of the disposable `textkit` application.
2. At 17:02 UTC, the assistant made a real wrapped SDK/HTTP call with
   `alpha  beta\ngamma`. The baseline returned `{count:2}`.
3. The user's earlier confirmation that this exact input contains three words was explicitly
   reused. This is a repeated repair with prior genuine feedback, not a new human response.
   `report_feedback` linked that attribution to the actual new call, and `create_packet` froze it.
4. At 17:02:36 UTC, `get_evidence` and `get_context` returned the trace, feedback, reproduction,
   frozen packet and exact separate-repository/source pointers without missing references.
5. After retrieval, the assistant changed literal-space splitting to non-whitespace runs in
   the separate repository. PR #2 passed 16 tests and typecheck, and its Git-triggered Preview
   became READY. The live SDK endpoint returned 3.
6. At 17:06:18 UTC, the supported owner public-preview enrollment verified provider metadata
   and the MCP catalog, registered the candidate with the public baseline as parent, and returned
   `stable_changed:false`.
7. At 17:06:33/43/53 UTC, the original client returned **default 2 → pinned candidate 3 → default 2**.
   All four actual calls, including the original evidence call, were read back and had identical
   client/session identity. One retained gateway and FalkorDB graph served the whole sequence.

The MCP gateway URL and client configuration stayed fixed throughout. The preview was selected
explicitly with `dispatch.version`; calls omitting that selector continued to use stable.
Enrollment alone does not make a candidate the default.

The replay uses sanitized actual outputs and code changes. It is not a live screen capture.
Human wording, credentials, opaque trace identifiers and provider account IDs are excluded.
The source repo was separate from ToolTuner. The assistant performed coding externally;
no built-in coding runner or deployment-manager job is claimed. Owner enrollment stores the
source and parent version but no direct packet-to-candidate relationship. PR and deployment
receipts provide that external step's evidence; the graph artifact does not invent an edge.

## Reproduce the local smoke test

Prerequisites: Git, Node 24, npm, and Docker with Docker Compose and a running engine.
From the repository root:

```sh
npm ci
npm run typecheck
npm test
npm run demo:local
```

The launcher starts a real loopback FalkorDB, uses real SDK transports and the production
composition, and removes only its disposable graph. An existing database can be used instead:

```sh
FALKORDB_URL=redis://127.0.0.1:6379 npm run --silent demo > local-demo-receipt.json
```

This automatic smoke test intentionally uses a **prewritten reference candidate**. It verifies
the framework independently; it does not reproduce the human-feedback/code-authoring step or
stand in for the actual-feedback video. See [local setup](local-demo.md) and the [operator
runbook](demo.md) for service configuration, grants, and local fixtures.

## Reproduce an actual-feedback workflow

1. Start the gateway and a baseline MCP application according to the operator runbook. Enroll
   the baseline using the owner CLI. Use a real MCP SDK client to call its tool through
   ToolTuner's `dispatch`. Save the returned call reference.
2. Show the result to a person and wait for their actual feedback. Submit their feedback with
   `dispatch` to the builtin `flywheel.report_feedback` operation, bound to that exact call.
3. With the management grant, call `create_packet` using the real call and feedback references.
   With the development grant, retrieve the packet and evidence before coding. Do not invent
   feedback or reuse the old smoke-test candidate as newly generated work.
4. Make and test a fresh change. Deploy it as a real preview using an authorized existing
   provider project. Keep the source commit, immutable deployment URL, and provider readback.
5. Use the explicit owner `application enroll-public-preview` command documented in
   [public preview enrollment](public-preview.md). Its input requires the exact source,
   deployment, project, team, baseline parent, selected tools, `auth_mode:"none"`, and an
   explicit supported network policy. Protected upstream enrollment remains a separate path.
6. On one SDK client, call the default, pin the returned candidate version, and call the
   default again. Verify both returned values and `resolved_version`. Enrollment must not
   silently change stable. Read the persisted calls and compare client/session identity.

Public preview deployment needs your own authorized provider account/project. No credential,
team/project identifier, private account, or production deployment is supplied by this guide.
The core local smoke test needs none of those accounts. Do not weaken authentication, TLS,
network guards, or deployment verification to make a recording pass.

## FalkorDB model and dependent queries

- `Application -[:HAS_VERSION]-> Version`; `Application -[:STABLE]-> Version`
- `Version -[:DERIVED_FROM]-> Version`
- `Call -[:RESOLVED]-> Version`; `Call -[:INPUT|OUTPUT]-> Evidence`
- `Feedback -[:ABOUT]-> Call`; `Feedback -[:TEXT]-> Evidence`
- `Packet -[:INCLUDES]-> Call / Feedback / Evidence`; `Packet -[:BASED_ON]-> Version`
- `Evaluation -[:COMPARES]-> Version`; `Evaluation -[:RAN]-> Call`
- `HumanDecision -[:SELECTED|EXPECTED_CURRENT]-> Version`

Parameterized queries in `src/db/evidence.ts` retrieve bounded lineage while checking access
scope along paths. Frozen packets preserve both a content digest and graph links to evidence
and baseline. Registry queries store immutable versions and guard owner-controlled stable
changes. Evaluation relationships are implemented, but the final actual-feedback sequence
above uses direct pinned calls rather than claiming a built-in autonomous experiment/job.

These are explanatory read-only operator queries. Production authorization lives in the
repository functions and grant policy; do not expose arbitrary queries to untrusted clients.

```cypher
MATCH (c:Call {owner_id:$owner,call_id:$call})-[:RESOLVED]->(v:Version)
OPTIONAL MATCH (f:Feedback {owner_id:$owner})-[:ABOUT]->(c)
OPTIONAL MATCH (p:Packet {owner_id:$owner})-[:INCLUDES]->(c)
RETURN c.call_id, v.version_id, f.feedback_id, p.packet_id, p.digest
```

```cypher
MATCH (a:Application {owner_id:$owner,application:$application})-[:HAS_VERSION]->(v:Version)
OPTIONAL MATCH (a)-[:STABLE]->(stable:Version)
RETURN v.version_id, v.doc AS version_document, stable.version_id
```

```cypher
MATCH (c:Call {owner_id:$owner})-[:RESOLVED]->(v:Version)
WHERE c.call_id IN $calls
RETURN c.call_id, c.doc AS call_document, v.version_id
ORDER BY c.created_at
```

Parse `version_document` and `call_document` as JSON in the trusted operator client.
The immutable version label and call client/session/requested-version fields are stored inside
those documents, rather than duplicated as graph properties. Do not publish raw documents:
they can contain private identities and source metadata.

No graph-ranking algorithm or generalized performance metric is claimed. The graph performs
provenance traversal, scoped evidence retrieval, and guarded state transition.

## AI assistance and limits

AI assistants helped implement code, tests, fixtures, and documentation and drove the recorded
SDK workflow. The entrant is responsible for understanding and explaining the implementation.
This is not a claim that the built-in isolated coding runner or automatic deployment manager
completed the workflow. No production activation, hosted ChatGPT/Claude onboarding, full-suite
green status, or autonomous coding is implied.
