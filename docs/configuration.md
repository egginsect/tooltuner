# ToolTuner configuration and naming migration

Use `TOOLTUNER_*` for product-owned settings. Existing non-product settings such as `FALKORDB_*`, `SUPABASE_*`, `OAUTH_*`, `PORT`, and `HOST` keep their names. This code change does not alter deployment settings, rotate credentials, migrate data, or enable a different authentication mode.

## Temporary environment compatibility

The supported suffixes are `RUNTIME_MODE`, `PUBLIC_ORIGIN`, `AUTH_MODE`, `OWNER_ID`, `OWNER_SECRET`, `CREDENTIAL_POSTGRES_URL`, `CREDENTIAL_KEYS`, `CREDENTIAL_ACTIVE_KEY_VERSION`, and `CREDENTIAL_POSTGRES_CONNECTION_MODE`.

Each canonical `TOOLTUNER_` setting temporarily accepts the same `FLYWHEEL_` suffix as an alias. Empty or whitespace-only values count as unset. A single nonempty value is used unchanged; identical nonempty aliases are accepted. Different nonempty values abort startup, including authentication and credential settings, without printing either value. Empty canonical values do not erase a configured legacy secret. Remove the old name after updating a deployment rather than leaving divergent settings. No removal date is scheduled in this change.

Credential custody uses the same resolution and conflict checks. Runner processes receive only their job-scoped capability and job/packet IDs, under both `TOOLTUNER_` and temporary `FLYWHEEL_` names. Neither prefix may be supplied by runner configuration. Privileged gateway credentials under either prefix remain forbidden in coding subprocesses.

## Automatic hosted Vercel origin

A backend cannot read a browser window's address. ToolTuner selects one canonical origin at startup from trusted deployment configuration:

1. A nonempty explicit `TOOLTUNER_PUBLIC_ORIGIN` (or its legacy alias) wins. Conflicting aliases fail rather than choosing one.
2. In hosted mode with `VERCEL=1` and `VERCEL_ENV=production`, use `VERCEL_PROJECT_PRODUCTION_URL`.
3. In hosted mode with `VERCEL=1` and `VERCEL_ENV=preview`, use `VERCEL_BRANCH_URL`, or `VERCEL_URL` if the branch value is unset. Never use the production domain for a preview.
4. Other hosts and environments need an explicit origin for protected hosted access. Local behavior is unchanged.

Selected metadata must be a DNS hostname without a scheme, credentials, port, path, query, fragment, whitespace, or trailing dot. ToolTuner adds HTTPS. Malformed selected metadata fails startup instead of falling back. No request `Host`, `Origin`, `Forwarded`, or `X-Forwarded-*` value creates an issuer or redirect destination. `OAUTH_ISSUER` and `OAUTH_RESOURCE`, if set, must match the selected origin and its `/mcp` endpoint. Origin selection never enables Supabase or changes authentication policy.

Connect clients to the selected canonical origin plus `/mcp`. A browser GET to `/authorize` on a deployment alias redirects to that fixed canonical origin before flow cookies are created. Wrong-host browser mutations and callbacks are rejected, never replayed. Token, registration, revocation and MCP protocol requests are not blanket-redirected. Stable production and branch domains keep the issuer stable across redeployments. The deployment-specific fallback changes when a new deployment is created, so clients must reconnect and provider redirect allowlists must be updated. Supabase requires the exact canonical `/auth/callback` redirect allowlist; automatic origin detection does not configure that external provider. Preview and production must use appropriate separate storage, configuration, grants, and provider redirect permissions.

Vercel's production domain metadata is populated even in previews. System environment variables must be exposed to runtime for automatic selection. See [Vercel's system environment variable reference](https://vercel.com/docs/environment-variables/system-environment-variables). An explicit override remains useful when choosing a custom domain instead of the domain Vercel selects.

## Stable persisted and protocol identifiers

The product name and service display name are ToolTuner. Existing compatibility identifiers deliberately remain unchanged: the default `flywheel` graph, database labels and table/role/policy names, credential references and authenticated-encryption context, the internal `flywheel` application and OAuth scope, and existing stored records. Renaming them would require a separate protocol/data migration. Module and type names are implementation details and are not changed mechanically. These retained identifiers do not change the public product name.
