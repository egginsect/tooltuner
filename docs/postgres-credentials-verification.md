# PostgreSQL custody verification

Verified 2026-10-18 UTC using synthetic credentials and ephemeral encryption keys only.
No real provider credentials, external OAuth grants, hosted databases, deployments or tunnels
were configured or accessed. Disposable PostgreSQL and FalkorDB services were stopped after
verification.

## Results

- Strict TypeScript typecheck: passed.
- Unit tests: 243/243 passed in nine files.
- Full synthetic credential suite: 11/11 passed in three files against isolated PostgreSQL
  17.6 and FalkorDB, including browser linking, owner CLI and protected runtime dispatch.
- Independent source security review: no blocking finding for the scoped refresh protocol.

The nine custody cases verify ciphertext-only SQL rows, exact binding enforcement, tamper
rejection, historical/missing/wrong-key behavior, write-time key rotation, competing processes,
stale writers and claims, repeat-claim rejection, recoverable pre-claim interruption, durable
fencing after uncertain remote outcomes, and lost claim/completion acknowledgements after
real committed SQL statements.

Eight simultaneous simulated remote refreshes exceed the adapter's five-connection limit,
demonstrating that network work does not retain database connections. The protocol uses
standalone atomic statements, no session state and no schema migration. A live
transaction-pooler proxy was not exercised.

The combined runtime checks perform local SDK dynamic registration, PKCE, fixture consent,
encrypted browser-link persistence, owner CLI account linking, expired-credential refresh and
protected upstream dispatch. They verify that CLI output and graph evidence contain neither
token values nor keys. These are local fixture results, not live-provider authorization claims.

## Unknown-outcome safety

A claim whose acknowledgement is unknown must never send the token request. Once claimed,
any interrupted token-request outcome remains fenced without lease expiry or automatic replay.
A committed replacement whose acknowledgement is lost fails the current operation; subsequent
reads may use the durably persisted replacement token. No outcome permits replaying the old
refresh token.

## Scope and environment limits

The broader FalkorDB integration suite was not rerun for this update. Earlier full-suite runs
encountered a missing `/usr/bin/node` executable in fixed-PATH credential-helper and sandboxed
job execution. That environment limitation is not evidence that namespaces are unavailable.

Live hosted connectivity, transaction-pooler integration, production key operations,
recovery/revocation procedures and deployment security validation remain unverified.
See [the custody guide](postgres-credentials.md) for commands and operational caveats.
