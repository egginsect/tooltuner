# Encrypted upstream credential custody

This optional adapter stores upstream OAuth access tokens, rotating refresh tokens and confidential
client information in PostgreSQL. FalkorDB still owns applications, immutable versions, grants,
opaque inbound OAuth token hashes, traces, feedback, packets and experiments. This is an additive
custody backend, not a migration of the gateway authorization model.

## Configure

Install locked dependencies with `npm ci`. The only new runtime dependency is `pg`, the
node-postgres driver; encryption uses Node's built-in AES-256-GCM implementation.

In the trusted process only, inject:

- `TOOLTUNER_CREDENTIAL_POSTGRES_URL`: PostgreSQL connection URL. No query parameters. Use TLS
  with normal certificate verification. Never pass a URL/password on the command line.
- `TOOLTUNER_CREDENTIAL_KEYS`: JSON object mapping key versions to base64-encoded 32-byte keys,
  sourced from an external secret manager or an equivalent protected environment. Do not commit
  keys, store them in PostgreSQL, forward them to a coding subprocess, or put them in log output.

The nonsecret runtime configuration in `RUNNER_CONFIG_PATH` may contain:

```json
{
  "credentialStore": { "kind": "postgres", "activeKeyVersion": "k1", "tls": true }
}
```

`tls: false` is accepted only for explicit loopback development. TLS defaults to true. Connection
URL query parameters are rejected so they cannot override verification. Remote database setup,
role provisioning and secret-manager access are operator responsibilities, not performed by this
adapter. PostgreSQL must be reachable only by trusted services; encrypted rows still reveal
nonsecret account and deployment metadata.

Save the credentialStore object alone in a nonsecret JSON file. With schema-owner database access,
initialize the one table explicitly:

```sh
npm run owner -- credential initialize --input /absolute/path/store.json
```

The owner CLI also connects to the configured FalkorDB. Runtime does not automatically create or
migrate SQL tables. After initialization, use a restricted database role with SELECT, INSERT and
UPDATE on `flywheel_upstream_credentials`; keep schema ownership and deletion privileges separate.
Readiness reports credential mediation as unverified until an actual exact-target use succeeds.

For account linking, use the same `credentialStore` object in the existing nonsecret owner-link
input and use a new `account.credential_ref`, for example `postgres:sample-local-a`. The normal
owner `account link --mode browser` PKCE flow writes its resulting SDK OAuth document directly to
encrypted custody. Do not place tokens in the JSON input. Existing mode works only when that exact
reference and target have already been securely provisioned. No production credential is bundled.
Pre-registered confidential-client bootstrap and issuer-specific registration policy still need an
operator-provided secure provisioning route; this adapter does not import plaintext secret files.

## Binding, refresh and failures

AES-GCM additional authenticated data includes a fixed domain/schema version, the credential
reference, owner, application, repository, auth configuration, environment, issuer, resource,
audience, scopes, upstream URL, commit and deployment ID. The key version and algorithm are also
authenticated. The caller supplies the expected binding from the trusted registry, rather than
trusting identity metadata read from the encrypted row. Creation timestamps are not identity.

One PostgreSQL reference is bound to one exact deployment/commit/resource tuple. Reusing it for a
preview, another commit, another audience or another owner fails closed. Link a separate account
and credential reference for each separately authorized target; do not copy a rotating refresh
credential across references. Automatic multi-preview credential derivation is not implemented.
The existing helper and read-only environment adapters retain their behavior.

Refresh uses short, atomic PostgreSQL statements and supports direct, session-pooled and
transaction-pooled endpoints. Reading an encrypted snapshot and issuer discovery do not claim
or consume a refresh token; failures before the claim can safely retry. Immediately before the
token request, a compare-and-swap marks the exact binding/version as refreshing and advances
its version. Only the successful claimant can persist the replacement encrypted document,
advance the version again and clear that fence. Competing claims and stale ordinary writes
fail closed. No database connection or session lock is held across network requests. Omitted
refresh tokens in an issuer response preserve the prior refresh token.

The refresh marker is committed independently of the remote operation. Once claimed, even a
crash before sending the request is conservatively uncertain. Interrupted token requests and
unknown claim acknowledgements leave the credential fenced rather than reusing a possibly
consumed refresh token. There is no automatic timeout reset. An unknown completion write
returns failure: storage may retain the fence or already contain the committed replacement,
which a later read can use. Neither outcome permits replaying the old refresh token.
An owner must reconcile the
issuer state and reauthorize under a new reference/account binding; blindly clearing the fence or
restoring an old database snapshot can replay revoked credentials. Root writes are insert-only;
there is no blind overwrite/relink escape hatch. Driver errors and credential values are never
included in adapter errors. An uncertain write is not reported as successful.

## Keys and operational limits

This is direct AES-256-GCM with a fresh random 96-bit nonce per write and an external versioned
256-bit keyring. It is not the legacy wrapped-DEK implementation and does not claim KMS-backed
envelope encryption. The keyring must retain old versions until all corresponding rows/backups
have been deliberately migrated or retired. New writes use `activeKeyVersion`; reads require the
row's recorded key version. Missing/wrong keys and modified ciphertext/tags fail closed. Merely
changing the active version does not bulk-reencrypt old rows.

A production rollout still needs external key lifecycle/rotation tooling, backup and recovery
policy, database TLS/role controls, revocation/deletion procedures, monitoring without secrets,
issuer-specific refresh recovery, and an operational security review. Database rollback attacks,
a compromised runtime/keyring, JavaScript heap zeroization and provider-side revocation are not
solved by encryption at rest. The runtime database role is trusted for refresh-fence integrity; a database administrator can restore an old valid ciphertext/version/fence snapshot. Authentication secrets never belong in graph evidence or packets.
No real accounts, external grants, provider tokens or deployment state were used in verification.

## Focused verification

Run `npm run typecheck`, `npm test`, and the existing real-FalkorDB `npm run test:integration`.
The separate `npm run test:credentials` needs `TEST_CREDENTIAL_POSTGRES_URL` pointing to a disposable
loopback PostgreSQL database, plus `FALKORDB_URL` for the one end-to-end runtime check. It creates the credential table and leaves synthetic rows in that
disposable database. Its random ephemeral keys and token fixtures are test-only. Checks cover
ciphertext-only rows, every identity field, tag corruption, key-version reads/rotation, independent
connections and a separate process contending for refresh, stale CAS, durable interrupted-refresh fencing, pre-claim retry and connection-free network work, and synthetic browser linking/CLI/runtime dispatch without secret graph evidence. Do not run
it against a real custody database.
