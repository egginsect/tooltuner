# Contracts (TOO-65)

`src/contracts.ts` is the only source of shared types, zod schemas, limits, ids and
errors. This page explains it. If the two disagree, the code wins. Fix the page in
the same change.

`src/runtime.ts` composes the real gateway, durable recorder, evidence/feedback/packet
handlers and configured job/experiment adapters. Later module indexes are bootstrapped in
that composition layer; the auth layer's schema registry remains auth-only. Unconfigured
operations are omitted from discovery and remain explicitly unavailable on dispatch.

## Outer API (the only three MCP tools)

| Tool | Input | Output |
|---|---|---|
| `list_apps` | `{}` | `{apps:[{application,stable_version,description}],completeness}` |
| `describe` | `{application,version?}` | `{application,resolved_version,schema_digest,tools:[{name,description,input_schema,effects}]}` |
| `dispatch` | `{application,version?,tool,args,idempotency_key?}` | `{call_ref,application,resolved_version,outcome,result?,error?,completeness}` |

- Every call is filtered by the caller's grant:
  - `list_apps` returns only the visible apps.
  - `describe` returns only the allowed inner tools.
  - `dispatch` re-checks the same policy, so calls that skip the catalog are still denied.
- Version resolution:
  - With no `version`, the stable pointer is used.
  - A `version` that names a missing version fails with `version_unavailable`. It never falls back to another version.
  - A `version` may be a `ver_…` id or a per-app label (`v1`, `v2`).
- `dispatch` pins `resolved_version` once, at admission, and validates `args` against that version's schema.
- Owner, agent, client, grant and session come only from the verified token. Args can never override them.
- The outer `dispatch` can perform writes. Its MCP annotations are therefore not `readOnlyHint`.

## Internal application `flywheel`

It is reached through the same `describe` and `dispatch` tools (`application:"flywheel"`).

| Operation | Group | Notes |
|---|---|---|
| `report_feedback` | user | Append-only. ACK only after a durable FalkorDB write. Same key and same content returns the same record; same key and different content returns `idempotency_conflict`. |
| `get_context` | development | Bounded metadata plus lineage edges and a cursor. |
| `get_evidence` | development | Unauthorized refs and nonexistent refs both go to `missing_refs`. |
| `create_packet` | management | Server-side freeze from authorized refs. The ACK is `{packet_id,digest,missing_refs}` only. |
| `start_job` | management | Durable record first, then launch. Same key returns the same job. `unknown` is reconciled, never resubmitted blindly. |
| `get_job` | management | Real state and receipts. |
| `register_preview` | management | The server re-reads the job's verified deployment. Caller URLs are ignored. |
| `run_experiment` / `get_experiment` | management | Replays the same input against pinned versions. |
| `recommend_candidate` | management | A record only. It never changes stable. |

Rules:
- Unimplemented operations are hidden from `describe`, and `dispatch` returns `operation_unavailable`.
- Human `merge`, `activate` and `rollback` are not reachable through any grant. They exist only in the owner CLI.

## Grants

A `Grant` has two parts:
- `groups`: any combination of `user`, `development` and `management`.
- `allow`: lists `apps` (or `["*"]`), optional per-app `tools`, and `repos`.

An optional `scope` (`job_id`, `packet_id`) narrows development reads to a single coding job's packet.

| Grant | Sees and can call | Denied |
|---|---|---|
| user | allowed upstream app tools, `flywheel.report_feedback` | evidence reads, packets, jobs |
| development | `get_context`, `get_evidence` (packets included) | upstream tools, `create_packet`, `start_job`, `register_preview` |
| management | `create_packet` … `recommend_candidate` | raw evidence (`get_context`, `get_evidence`) |
| union | exactly the union of the selected groups, still limited by the allowlists | human decisions, always |

Brand or client type never decides permissions. Only the grant does.

## Records

Every record carries `schema_version:1`, `owner_id`, `created_at`, `provenance` and `completeness`. Secrets appear only as reference names (`auth_config_ref`). They never appear in payloads or in the graph.

| Record | Key points |
|---|---|
| Call | Admission and completion are separate `CallEvent`s. A missing completion means outcome `unknown`. Tool `success` does not mean the task succeeded. |
| Evidence | Sanitized, bounded (16 KiB) JSON of call input or output, or feedback text. Records `truncated` and `redacted_paths`. |
| Feedback | Append-only. Points to exact `call_refs`. `observed` and `expected` are optional. |
| Packet | Immutable snapshot. A revision creates a successor (`successor_of`). |
| Job | States `queued → launching → running → completed / failed / cancelled`, plus `unknown` (see `JOB_TRANSITIONS`). The receipt is trusted runner-start evidence. `result.requested_deployment` is untrusted. |
| Version | Immutable. `digest` covers `VERSION_DIGEST_FIELDS`. `runtime_target.url` is the deployment-unique URL. `state` and `readiness` are kept separate from the stable pointer. |
| StablePointer | One per app. Changed only by owner-CLI `HumanDecision` records. |
| Evaluation, Recommendation | Pinned versions, input, criterion and config. Per-version `task_outcome`. |
| HumanDecision | `merge`, `activate` or `rollback`. Merge and activate are separate records. `activate` checks `expected_current_version_id`. A post-merge build is a new version. |

## Ids, digests, idempotency

- Ids are `<prefix>_<10 base36 time><16 hex>`: `call_`, `evt_`, `evd_`, `fb_`, `pkt_`, `job_`, `ver_`, `eval_`, `rec_`, `dec_`, `grant_`.
- Digest: `sha256:` + hex of canonical JSON. Canonical JSON means UTF-8, sorted object keys, no whitespace, `undefined` dropped, array order kept.
- Fields left out of every digest: `schema_version`, `created_at`, `provenance`, `digest`.
- A packet digest also leaves out `packet_id`, `owner_id` and `completeness`. Identical packet content therefore yields the same logical packet.
- Example: `canonicalJson({b:1,a:[2,{d:null,c:"x"}]})` gives `{"a":[2,{"c":"x","d":null}],"b":1}`.
- Dispatch idempotency (`idempotency_key`) and event ingest dedup (`event_id`) are different mechanisms. Exactly-once is not promised when the upstream lacks idempotency.

## Errors

`{code,message,field_path?,retryable,outcome_certainty}`. `outcome_certainty` is one of `not_executed`, `executed` or `unknown`.

| Code | When |
|---|---|
| `unauthenticated` | Missing, invalid or expired token (HTTP 401 with `WWW-Authenticate`). |
| `forbidden` | Visible app, but the operation is outside the grant's groups or allowlists. |
| `not_found` | Unknown ref or app, and also apps outside the grant (existence is not leaked). |
| `invalid_args` | Schema validation failure (`field_path` set). |
| `version_unavailable` | Pinned version missing, not ready, or deployment gone. No fallback. |
| `operation_unavailable` | Operation not implemented or configured (for example, no runner). |
| `storage_unavailable` | FalkorDB write or read failed. Nothing is acknowledged. |
| `outcome_unknown` | The side effect may or may not have happened. Reconcile before retrying. |
| `ingest_conflict` | Same `event_id` with different content. |
| `idempotency_conflict` | Same idempotency key with different content. |
| `stale_expected_current` | Activation `expected_current` no longer matches stable. |
| `upstream_error` | Upstream unreachable or a protocol failure. |

## Limits (rationale)

| Limit | Value | Why |
|---|---|---|
| refs per request | 20 | Enough for a packet. Keeps graph reads bounded. |
| page size | 20 default, 50 max | Keeps responses small enough for agent context. |
| text | 4000 chars | One feedback paragraph. Large pastes are rejected, not truncated silently. |
| evidence blob | 16 KiB | Fixture payloads are small. Larger payloads are truncated with `truncated:true`. |
| dispatch timeout | 30 s | Longer than a normal tool call. A timeout records `unknown`. |
| experiment versions | 4 | Baseline plus a few previews. |

## Graph model (FalkorDB, graph `flywheel`)

Each record is one node.
- The label is the record name: `Application`, `Version`, `Call`, `CallEvent`, `Evidence`, `Feedback`, `Packet`, `Job`, `Evaluation`, `Recommendation`, `HumanDecision`, `Grant`.
- The key property is the record id (`application` for `Application`).
- `doc` holds the full record as canonical JSON. Read it back and parse it with the contract schema.
- Scalar properties used for filtering are copied next to `doc`: `owner_id`, `application`, `created_at`, `state`, `outcome`.

Edges:

| Edge | Meaning |
|---|---|
| `(Application)-[:HAS_VERSION]->(Version)` | Registry. |
| `(Application)-[:STABLE]->(Version)` | Stable pointer. Exactly one per app. Only the owner CLI changes it. |
| `(Version)-[:DERIVED_FROM]->(Version)` | Parent version. |
| `(Call)-[:RESOLVED]->(Version)` | Version pinned at admission. |
| `(Call)-[:HAS_EVENT]->(CallEvent)` | Admission and completion events. |
| `(Call)-[:INPUT\|OUTPUT]->(Evidence)` | Sanitized call payloads. |
| `(Call)-[:CAUSED_BY]->(Call)` | `causal_refs`. |
| `(Feedback)-[:ABOUT]->(Call)`, `(Feedback)-[:TEXT]->(Evidence)` | Feedback target and text. |
| `(Packet)-[:INCLUDES]->(Call\|Feedback\|Evidence)` | Packet contents. |
| `(Packet)-[:BASED_ON]->(Version)`, `(Packet)-[:SUCCESSOR_OF]->(Packet)` | Packet lineage. |
| `(Job)-[:FOR_PACKET]->(Packet)`, `(Job)-[:PRODUCED]->(Version)` | Job input and the preview it produced. |
| `(Evaluation)-[:COMPARES]->(Version)`, `(Evaluation)-[:RAN]->(Call)` | Experiments. |
| `(Recommendation)-[:FROM]->(Evaluation)`, `(Recommendation)-[:RECOMMENDS]->(Version)` | Recommendations. |
| `(HumanDecision)-[:SELECTED\|EXPECTED_CURRENT]->(Version)` | Owner decisions. |
