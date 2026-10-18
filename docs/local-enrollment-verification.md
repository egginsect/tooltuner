# Local application enrollment verification

Recorded 2026-10-18T00:47:35.689Z against the `stack/m1-runtime` source at
`bbaeedf7f5d29462d15e4e1d552b06c080b74629` plus the local enrollment change.
This is real local SDK evidence, not hosted-client acceptance.

## Actual upstream and isolation

- Opportunity Engine baseline: `egginsect/opportunity-engine` at
  `1bb4e849c039e62ba6479896289d3c0ca1c033c2`; all 344 downloaded source files
  were compared byte-for-byte with the commit archive.
- Candidate: local-only source snapshot commit
  `3c926ad40d8be57492ecf7e88289dfaf6957f78c`, not a published upstream commit.
  Its real `list_opportunities` handler adds `syntheticVariant: "candidate-v1"`.
  This deliberate marker proves routing isolation, not a bug fix or improvement.
- Separate loopback MCP endpoints and fresh PostgreSQL 17.6 clusters; all 42 actual
  migrations ran in each. Identical fixed TestCompany/TestRole fixtures were seeded.
  Another fictitious owner's row was present to test isolation.
- An external test-only Streamable HTTP adapter imports OE's actual registry,
  handlers, request context, runtime guard, and database code. It supplies a
  synthetic principal instead of exercising Next/Neon/OAuth authentication.
- Through actual `runWithRequestContext` and `withDatabaseSession`, the runtime
  role was `opportunity_engine_app`, both user settings matched the fixture owner,
  `row_security_active('opportunities')` was true, and unfiltered SQL returned only
  that owner's row. This was not merely a handler-side filter assertion.
- Runtime, migration, database and fixture subprocesses used an explicit environment
  allowlist. No production data, connector credentials, public tunnel or deployment.

## Passed manual end-to-end checks

The actual OE `list_opportunities` result is JSON in MCP text content, not
`structuredContent`. Its parsed result matched an independently specified fixture
expectation; no result or schema was fabricated by the gateway.

1. Concurrent first enrollment and concurrent new-version enrollment returned the
   same stored winner; identical replay was idempotent. Conflicting immutable
   source identity and unknown selected tool names were rejected.
2. Remote, hostname-based, credential-bearing and query-bearing enrollment URLs
   were rejected. Stable was absent before and after enrollment.
3. One real gateway MCP client dispatched baseline, candidate, then baseline again.
   Each returned the expected actual output and exact registered version. The
   candidate's persisted parent was the baseline version; no reconnect or fallback.
4. Actual call/input/output records and trace context were read back from FalkorDB.
   Truthful positive feedback produced a durable ACK and complete frozen packet.
5. Distinct synthetic user, development and management credentials enforced their
   grant boundaries. Packet-scoped reads excluded a later unrelated call. Missing
   versions and an absent stable pointer failed closed.
6. Both registered catalogs contained exactly `list_opportunities`. An attempted
   `update_opportunity` dispatch was denied by the scoped grant; even a broad local
   user grant received `operation_unavailable` because the tool was not enrolled.

Baseline version: `ver_c5f7eb727335e6c6c572c5da8e`.
Candidate version: `ver_dd046ef7daa0ead237f4bec8df`.
Selected-catalog digest (both):
`sha256:d27da5be6218b79c8cfba8578988325593501e408a229ef847e9ccb80d8ccf18`.
Packet digest:
`sha256:53232eee84786bfd74cb4ee6c2d028c7391d8723ae917b2bee2e41f88f7708eb`.
The test-owned UUID graph and its temporary grants/tokens were deleted after the run.

## Known compatibility limit and other checks

Full OE catalog enrollment still fails: its draft-07 `handoff_opportunities`
schema contains pattern `^https\:\/\/`, whose escaped colon is rejected by the
current AJV Unicode-regex mode. The explicit local tool allowlist avoids that
unrelated write schema; it does **not** repair it or establish full OE compatibility.
Validation was not weakened and OE production behavior was not changed.

Framework typecheck and all 60 unit checks passed. Existing real-FalkorDB integration
checks remained 78/93 passed, with the same 15 runner/deployment-environment failures
as the prior local baseline. The existing local OAuth/fixture demo passed. There is
no framework build command. Candidate OE typecheck passed. No new automated test
suite was added; the OE exercise was a separately run manual harness.

Remaining gates: protected upstream OAuth, real hosted client onboarding, public
HTTPS, production Next transport/authentication, coding-runner/deployment receipts,
and a genuine candidate quality comparison. This run establishes none of those.
