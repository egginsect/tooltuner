# Reproducible local improvement-loop demo

This is a real MCP SDK + production gateway + FalkorDB exercise using synthetic, read-only
technical fixtures. It needs no external account, coding-agent token, public endpoint, or
PostgreSQL. The corrected candidate is prewritten in `fixtures/server.ts`; this demo does **not**
claim that an AI agent generated a patch or that a hosted preview was deployed.

## Run

Prerequisites: Git checkout, Node 24+, npm and Docker Compose with a running Docker engine.
From the checkout root:

```sh
npm run demo:local
```

The launcher installs locked dependencies if absent, starts the supplied real FalkorDB with
`docker compose --env-file /dev/null -f docker-compose.yml up --wait falkordb`, and runs the demo. On first use Docker may download its
configured image. All listeners bind to loopback. No `.env` file is loaded by the demo.

If you already have a real FalkorDB, Docker is unnecessary:

```sh
FALKORDB_URL=redis://127.0.0.1:6379 npm run demo:local
```

Use `FALKORDB_PORT=16379 npm run demo:local` if the default Compose host port is occupied.
For an authenticated database supply `FALKORDB_USERNAME` and `FALKORDB_PASSWORD` separately;
never put a password in a URL or the recorded output. The database must allow creation and
deletion of a disposable graph. `npm run demo` runs only the exercise against an existing DB.

To capture machine-readable evidence after dependencies are installed:

```sh
FALKORDB_URL=redis://127.0.0.1:6379 npm run --silent demo > local-demo-receipt.json
```

Only that invocation's UUID graph is deleted at the end, including on failure. The Compose
database/container and its named volume remain available. `docker compose stop falkordb` stops
the service without deleting its data. Do not use `down -v` on a database containing useful data.
A failed assertion exits nonzero instead of producing a success receipt.

## Five-minute walkthrough

1. Enroll `textkit/v1`, `textkit/example-v2`, and the independent `catalog/v1` through the same
   generic owner enrollment function used by the CLI. Enrollment probes live MCP catalogs and
   leaves the stable pointer untouched. The owner explicitly activates baseline versions.
2. Authenticate real SDK clients using registration, PKCE and local owner consent. Each sees
   exactly three outer tools: `list_apps`, `describe`, `dispatch`. Inner tools follow grants.
3. On **one user SDK client**, call `word_count` with `alpha  beta\ngamma`. The faulty stable
   returns **2**; explicitly pinning the corrected candidate returns **3**; the next default
   call still returns **2**. Both versions run real upstream calls through the shared core.
4. Submit negative feedback, freeze an improvement packet, and read evidence. Assert durable
   call/version references, feedback and packet linkage, and actual graph lineage edges.
   The management grant runs the deterministic comparison: baseline **fail**, candidate **pass**.
   Comparison does not change stable.
5. Use the **local owner control channel**, separate from MCP, to activate the candidate.
   The same user client now gets **3** by default. An owner decision using stale expected-current
   state is rejected. Owner rollback restores **2**, again on that same client. All MCP grants,
   including management, are denied activation/rollback operations.
6. Exercise a refreshed OAuth token with an actual SDK call. Disconnect storage and require
   health 503; reconnect and recompose the runtime, then read the persisted records and call
   with that token. A separate Node process independently verifies the call, packet digest,
   completed comparison, stable pointer and owner decisions directly from FalkorDB. The original
   listener then gives way to the real production service process. That process is started,
   stopped cleanly with SIGTERM, and restarted on the same origin. After both starts, existing
   user/development tokens perform dispatch and read the original call and packet via MCP.

The receipt contains timestamp, checkout commit, dirty flag, passed checks, numerical transcript,
version/call/feedback/packet/evaluation/decision references, and an explicit pending-work list.
The refs identify records checked before the disposable graph is deleted; they are not durable
links after demo cleanup. A dirty checkout is not committed-artifact provenance. The two fixture
versions intentionally share the checkout source commit but have distinct immutable runtime
URLs and labels. Enrollment's source identity is an owner assertion, not provider attestation.

The service restart uses the actual `src/server.ts` entrypoint, retains the same graph and OAuth
origin, and requires clean exit after each start. The fixture server and database remain running;
this is not a database-process crash/restart or storage power-loss durability claim.

See [recorded verification and limits](local-demo-verification.md).

## Verify and interpret

```sh
npm run typecheck
npm test
FALKORDB_URL=redis://127.0.0.1:6379 npm run test:integration -- tests/integration/runtime.test.ts
FALKORDB_URL=redis://127.0.0.1:6379 npm run test:integration
```

The runtime integration test asserts the full demo transcript and child-process readback.
The full suite includes unrelated coding-sandbox and credential-helper checks; do not describe
it as passing when the host lacks working bubblewrap or a helper's executable path. The demo
never weakens isolation or substitutes an in-memory DB to get a pass.

PostgreSQL is optional encrypted upstream-credential custody, not the graph or a requirement
for these anonymous loopback fixtures. See [PostgreSQL setup](postgres-credentials.md) and
`npm run test:credentials` for real-adapter verification. That suite requires both real databases
and its documented test environment; this demo does not assert live provider-account linking.

Remaining separate milestones: hosted ChatGPT/Claude consent and calls, public HTTPS, an actual
isolated coding-agent job, a manager-verified hosted preview, and production owner decisions.
None is implied by a successful local demo.
