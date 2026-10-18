# Multi-user graph boundary review

The graph layer already partitions runtime data by the owner identity supplied by the authenticated principal. Moving the authentication boundary to a verified provider subject does not require rewriting existing graph owners. Legacy owners must remain unchanged; no login may claim or migrate them automatically.

## Boundary inventory

- Catalog: `createGatewayCore` checks that principal and active grant agree. `listApplications` filters owner; application lookup and STABLE pointers use a composite owner/application registry key. Same application names may belong to different owners.
- Describe and dispatch: immutable version resolution takes the principal owner and the selected application. Explicit foreign version IDs do not fall back to STABLE. Outer inputs are strict and reject an owner override. A tool's ordinary business argument named `owner_id`, if its own schema permits it, does not select the gateway tenant.
- Traces and evidence: read scope originates from the principal and grant. Graph reads filter owner, applications, repositories, permitted tools and optional packet/job references. Context traversal checks every intermediate node's owner and scope; lineage endpoints must be in the authorized page. Record authorization additionally checks returned record ownership and linked evidence parents. Cursors bind owner, grant and query.
- Feedback: all target calls and attached evidence are authorized before a write. The feedback owner and idempotency key derive from the principal; foreign references receive the same missing-resource error as absent references.
- Packets: authorized calls establish the baseline. Version lookup, predecessor packet, attached records and snapshots stay within the owner/application/repository scope. Packet deduplication includes owner even though the content digest intentionally excludes it.
- Jobs: handlers derive owner from context; job reads, updates, verification and graph links use owner predicates. Starting a job checks packet ownership and an exact owner/application/repository configuration. A foreign job is rejected before polling, artifact validation or preview registration.
- Artifacts: there is no public artifact loader. The manager receives a job only after the owner-scoped lookup. The runner verifies its workspace against the server-generated globally unique job ID, branch, commit and artifact digest. These globally unique IDs are not tenant selectors or authorization credentials.
- Preview registry: trusted management context, job, packet, manager verification and configured project must agree on owner and provenance. Parent version reads are owner scoped. Registration never changes STABLE.
- Account and credential bindings: graph metadata uses owner/reference and owner/reference/URL composite keys. Secret custody is a separate adapter boundary and requires its own database isolation review.
- Human decisions: activation, rollback and merge remain unavailable through MCP. Local CLI helpers take trusted owner context and overwrite any excess runtime owner property supplied in receipt input. Selected versions must belong to that owner/application before a STABLE write.
- Internal exceptions: recorder completion loads by server-created call ID without an owner parameter, but only the durable recorder calls that loader. Public dispatch cannot supply a completion call ID. Human decision replay lookup is globally keyed, but only returns an exactly identical owner-bearing decision document. Neither helper is a public read API.

## Authentication integration requirements

Authentication must establish a canonical verified user UUID and load only that user's active grants. Runtime callers cannot choose the owner through request arguments, headers, claimed subjects or unverified token payloads. New authenticated users receive no grants automatically. Trusted CLI configuration may select an owner administratively and must support UUIDs while preserving legacy owner values. Development-token issuance must use the persisted job grant's owner rather than a process-global owner. Those authentication and configuration changes are separate from this graph test package.

## Verification and limitations

`tests/unit/multiuser-boundaries.test.ts` runs real gateway, handler and repository functions against a small synthetic graph adapter. It covers two UUID owners with the same application name, owner-specific STABLE and version selection, foreign dispatch rejection, strict owner override rejection, trace/evidence/feedback/packet denial, job and artifact gating, CLI activation owner precedence, credential lookup keys and idempotency partitioning.

The adapter requires tenant predicates in the supported query text and rejects unsupported reads and all writes. These are synthetic integration checks in the unit suite, with no database, upstream call, credentials, deployment or production data. They do not establish real graph constraint behavior by themselves.

`tests/integration/multiuser-uuid.test.ts` additionally executes the actual repository Cypher against a disposable local FalkorDB. Two UUID owners have identically named applications, version labels and credential references. The tests verify distinct STABLE pointers, foreign-version denial, trace and evidence isolation, feedback and packet denial, and separate credential bindings. The dedicated UUID suite passed all 3 tests; the existing evidence integration suite passed all 17 tests in the same run. The process used an isolated loopback port with disk persistence disabled, each suite deleted its randomly named graph, and the database process was stopped after testing. No external upstream or production database was contacted.

Strict typechecking and all 252 unit tests passed. These checks do not establish provider authentication correctness, PostgreSQL row-level-security enforcement or production migration readiness.

No production graph changes or owner reassignment were required by this review.
