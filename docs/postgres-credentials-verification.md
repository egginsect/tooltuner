# PostgreSQL custody verification

Verified 2026-10-18 UTC using synthetic credentials and ephemeral random encryption keys only.
The additive source started from remote runtime tip `bbaeedf7f5d29462d15e4e1d552b06c080b74629`
plus the local enrollment layer. Local snapshot commits are test provenance, not remote ancestry.
No real provider credentials, external OAuth grants, production databases, deployments or tunnels
were configured or accessed.

## Results

- Strict TypeScript typecheck: passed.
- Existing unit tests: 60/60 passed in six files.
- New focused custody tests: 6/6 passed in two files against actual PostgreSQL 17.6 and FalkorDB.
- Existing full FalkorDB integration suite: 78/93 passed, with the same 15 failures as the unchanged
  runtime baseline in this execution environment. No isolation constraints were weakened.
- Independent source security review: no remaining blocking findings for this scoped MVP.

The six custody checks prove encrypted SQL row contents, exact binding enforcement for every
identity field, tamper rejection, historical/missing/wrong-key behavior, write-time key-version
rotation, independent-session and separate-process lock contention, stale compare-and-swap
rejection, durable interrupted-refresh fencing, and safe failure after terminating the exact
synthetic database session while refresh work is awaited.

The combined runtime check performs real local SDK dynamic client registration, PKCE and fixture
consent, encrypted browser-link persistence, account linking through a separate owner CLI process,
resource-bound refresh of an expired fixture credential, and successful protected upstream runtime
dispatch. It verifies that CLI output and graph evidence contain neither token values nor keys.
It is a local fixture result, not an external provider or real client-session authorization claim.

## Existing environment blockers

Eight credential-helper integration cases fail because the fixture helper uses `/usr/bin/env node`
with the production helper's fixed `/usr/bin:/bin` PATH, while this host provides Node under `/opt`.
Seven sandboxed-job integration cases cannot start because this environment disallows the required
bubblewrap networking/namespace operations and has no `/usr/bin/node` wrapper runtime. These are
unchanged baseline failures; successful behavior after removing those blockers remains unverified.

The database services ran in isolated local test clusters and were stopped after verification.
Use the commands and operational caveats in [the custody guide](postgres-credentials.md) to
reproduce. Production key operations, recovery/revocation procedures and independent deployment
security validation remain outside this implementation.
