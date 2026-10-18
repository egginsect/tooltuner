# Local demo verification — 2026-10-18

Scope: the generic shared-core loop documented in [local-demo.md](local-demo.md), with real
FalkorDB, real MCP SDK transports and synthetic read-only fixtures. No public endpoint,
external coding agent, provider account, deployment or production activation was used.

## Acceptance

- Strict TypeScript check, including all scripts: passed.
- Unit suite: 60/60 passed.
- Production runtime integration file: 5/5 passed, including the complete demo transcript.
- Existing-database one-command launcher: passed against real FalkorDB.
- Real PostgreSQL credential-adapter suite: 6/6 passed against real PostgreSQL and FalkorDB.
- Full integration suite: 78/93 passed, 15 failed. This is **not** a full-suite green result.
  The failures remain in gateway credential-helper and isolated job tests, matching the
  prior host baseline: executable/PATH limitations and unavailable bubblewrap networking.
  Isolation was not weakened and the demo does not invoke the coding runner.
- Shell syntax and whitespace checks: passed.
- Independent source review: accepted after fixes to Compose configuration selection,
  frozen packet content assertions and owned-child cleanup on interruption.

## What the demo proves

Live generic enrollment leaves stable unchanged. One client observes baseline 2, pinned
corrected candidate 3, and unchanged baseline 2. Durable calls, feedback, complete frozen packet
contents and graph lineage are checked. A real deterministic experiment scores fail/pass.
Owner-only activation changes the default to 3, a stale owner decision is rejected, and rollback
restores 2. MCP grants cannot activate or roll back.

An actual refreshed token performs calls. Storage disconnect returns health 503; reconnection
reads persisted state. An independent process verifies the packet digest, comparison and owner
decisions, then starts the real service entrypoint, stops it cleanly and restarts it on the same
origin. Existing user and development tokens work after both starts; the original call/packet
are retrieved via MCP. The fixture and database stay up throughout this service-restart check.

## Limits

Docker is not installed on the verification host, so Compose auto-start is syntax/source checked,
not executed here. The launcher branch using an existing real database is exercised. The checked-in
Compose file is explicit and dotenv loading is disabled to avoid port/configuration ambiguity.

The candidate is a prewritten whitespace fix, not an agent-produced improvement. This is not
hosted ChatGPT/Claude compatibility, real provider-account linking, a verified hosted preview,
or a database crash/power-loss recovery test. Demo records are removed with its UUID graph;
the JSON receipt is the remaining acceptance evidence. Receipts from the isolated verification
checkout identify its local snapshot commit, not a published upstream commit.
