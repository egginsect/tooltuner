# Backend-only credential RLS

## Boundary

PostgreSQL stores only encrypted upstream credential envelopes. No anon, authenticated, or service_role table/column grants are retained by the migration. No ordinary application user may read ciphertext or secret fields directly. New tenant owner namespaces are verified Supabase user IDs; existing non-UUID namespaces are preserved, never silently assigned to a new user. Authenticated principal-to-owner propagation and owner-scoped registry queries are mandatory prerequisites. PostgreSQL RLS does not protect FalkorDB; graph queries need their own owner checks.

The restricted backend role supplies owner and exact-binding context for each SQL statement in a short transaction. RLS checks both on reads and writes. This is defense against accidentally unscoped SQL, not independent verification of a JWT: a compromised trusted backend can choose arbitrary context and access other tenants' envelopes. Neither a custom GUC nor the role's database connection authenticates the human. Do not expose this connection, an arbitrary SQL endpoint, or a context-setting RPC to clients. Browser roles receive no credential policy.

Hosted multiuser configuration must pass `requireRls: true` to the credential adapter. Every checked-out transaction then verifies the actual role, memberships, schema privileges, table ENABLE/FORCE flags, exact reviewed policy and absence of browser grants. Administrative URLs and policy/grant drift fail closed. Exact PostgreSQL policy deparsing is intentionally strict: a database-version change that renders it differently requires review and tests, not a bypass. The default false is only for explicit legacy/local compatibility; it is not a multiuser security mode.

## Review and rollout

1. Review the existing table, columns, policies, role memberships, schema CREATE privileges, views, SECURITY DEFINER functions, default privileges, and every existing grant. Existing policies cause this migration to abort rather than merge permissive rules. Remove or constrain any wrapper that exposes credentials. Do not change unrelated project-wide grants automatically.
2. Separately provision a dedicated flywheel_credential_runtime login without SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION, privileged memberships, schema CREATE or table ownership. The migration creates no role, password or persistent credential. Provisioning and switching production credentials require separate approval and a secure secret-management flow. Use a distinct schema-owner login for migrations.
3. In a maintenance window stop old credential writers, run migrations/001_credential_rls.sql explicitly as the schema owner, deploy this adapter, then switch its configured connection to the restricted role. The migration backfills owner_id from binding JSON, validates consistency and preserves encrypted bytes. Bad JSON or missing/empty owner namespaces abort the transaction. Plan locking time for the backfill. Application startup never applies this migration.
4. Smoke-test account linking and refresh with synthetic tenants. Verify the actual runtime login is neither a table owner nor privileged, and assert anon/authenticated lack table and column access. Confirm there is no old deployment still writing the previous schema. Resume traffic only after the tests pass. Restoring application code alone is not a safe rollback after the schema change; coordinate the adapter and schema.

The role receives SELECT/INSERT and UPDATE only on envelope, token_version and refreshing columns. It cannot update reference, binding or owner_id, delete, truncate, change policies or grant itself privileges. Every connection checkout sets transaction-local owner and binding, executes one statement, commits, and releases. Remote OAuth requests never hold a connection or transaction. Claims remain committed before refresh, and completion retains compare-and-swap fencing. A lost COMMIT acknowledgement is treated as unknown outcome and never automatically replayed.

ENABLE RLS defaults to deny without a matching policy. FORCE also subjects an ordinary table owner to row policies, but owners can change the table and policies. Superusers and BYPASSRLS roles still bypass RLS. Supabase service_role is such a privileged role; this migration revokes its direct grants rather than pretending FORCE constrains it. Inherited grants, privileged functions, schema ownership and migration credentials remain deployment review obligations.

## Verification

Run the ordinary typecheck and tests, then run the dedicated RLS suite using a fresh disposable loopback PostgreSQL database with an administrative test login:

    TEST_CREDENTIAL_RLS_ADMIN_URL=postgresql://test_admin@127.0.0.1:5432/test_db npx vitest run --config vitest.rls.config.ts

The suite creates synthetic roles with no passwords and must never target a deployed database. It exercises actual restricted-role connections, no/wrong context, cross-owner read/write denial, forged browser context, column grants, immutable identity columns, failed privilege escalation, FORCE owner semantics, legacy backfill and real CAS refresh. Tests of a caller-supplied context prove policy behavior, not JWT authenticity. Run the existing encrypted credential suite as well to cover AES-GCM and lost acknowledgements. Cross-tenant HTTP identity propagation is covered separately by the authentication suite.

Official sources: [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) and [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

To re-run the complete custody suite with the same restricted role after the RLS suite, keep its disposable database alive, set TEST_CREDENTIAL_POSTGRES_URL to the administrative inspection connection, TEST_CREDENTIAL_POSTGRES_RUNTIME_URL to the restricted role's connection, and TEST_CREDENTIAL_REQUIRE_RLS=1. Run `npx vitest run --config vitest.credentials.config.ts tests/credentials/postgres.test.ts`. This separation keeps test-only corruption and schema setup out of the runtime role.
