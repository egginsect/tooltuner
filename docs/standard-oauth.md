# Standard MCP OAuth owner linking

Flywheel can explicitly link an MCP resource whose authorization server does not offer RFC 7662 introspection. This is an owner-controlled compatibility mode, not a fallback when introspection fails.

## Authority and custody

Set account `validation_mode` to `standard_oauth`. Omitted mode, or `introspection`, retains the existing introspection flow and requires the configured introspection endpoint. Standard mode requires a fresh owner authorization-code/S256 PKCE or advertised RFC 8628 device flow, an exact MCP URL used as both resource and audience, and the encrypted PostgreSQL store. Importing an existing credential document is rejected for this mode.

Issuer discovery, registration, token exchange and refresh stay on the explicitly configured issuer origin. Redirects are rejected. Protected resource metadata must match the exact resource and issuer. Its optional `scopes_supported` field may be omitted; when the resource or authorization server advertises scopes, requested scopes must be included.

Acquisition method, account digest, exact binding digest, requested scopes and acquisition time are stored inside the authenticated encrypted credential envelope. They record how Flywheel acquired a token; they are not independently verified token claims. The server does not decode opaque tokens or claim introspection occurred. Every standard-mode authorization performs authenticated MCP initialize/listTools at the exact bound endpoint before returning credentials for normal dispatch.

An omitted token-response scope inherits the requested scope for initial acquisition, or the prior granted scope for refresh. Explicit empty, insufficient or expanded scopes are rejected. An omitted expiration is permitted by OAuth; a supplied expiration must be positive, and expired credentials require a valid resource-bound refresh. Remote acceptance is checked on every use. PostgreSQL refresh locking, compare-and-swap and the durable refresh fence remain intact. An invalid or uncertain rotated response leaves the fence closed and requires reconciliation or fresh authorization; Flywheel never silently retries the old refresh token.

## Owner commands

Use the existing nonsecret link document shape with `validation_mode: "standard_oauth"`, no `introspection_url`, and a `postgres:` credential reference. Never place tokens, device codes, database passwords or encryption keys in that document.

- `npm run owner -- account link --input link.json --subject OWNER --mode browser` starts S256 PKCE with a state-checked ephemeral loopback callback. The browser must be able to reach that callback's network namespace.
- `npm run owner -- account link --input link.json --subject OWNER --mode device` uses an advertised device authorization endpoint and a fresh dynamically registered public client. It prints only the verification URL, user code and expiry. The owner signs in and approves in their browser. Device codes remain in memory. Polling respects expiry, interval and `slow_down`; unknown errors terminate the flow without retrying uncertain success.
- `--mode existing` remains available only for legacy introspection accounts.

After linking, `npm run owner -- application enroll-remote --input enrollment.json --subject OWNER` consumes a document with `credentialStore` and `application` fields. The application object contains `application`, `description`, `label`, `source` (repository and immutable commit SHA), exact HTTPS `url`, `deployment_id`, `environment` (`preview` or `production`), `auth_config_ref`, and a mandatory nonempty `tools` array. The account and binding must already match every requested identity field.

Enrollment performs authenticated discovery and checks only the selected tools' schemas. An unsupported schema in an unselected tool does not widen or block the chosen capability surface. Enrollment does not invoke business tools, create grants or activate a version. Source/deployment provenance is explicitly owner-asserted, not provider-attested. Protected-preview attestation remains a separate, unchanged pathway.

OAuth scopes may cover a much broader surface than the selected tools. Keep the enrollment allowlist and downstream grant allowlist narrow; normal argument validation and dispatch policy still apply. A health-only trial should enroll and grant only the upstream health tool, use a scratch version selection and leave the stable pointer unchanged.

## Limitations

There is no anonymous-endpoint rejection or independent audience introspection claim in standard mode: trust is the configured issuer, fresh resource-bound acquisition, authenticated custody and the resource server's acceptance. Do not select this mode for a provider whose resource server cannot be trusted to enforce its own authorization.

A provider that omits scope initially but explicitly returns an empty scope on refresh cannot renew a credential requiring a nonempty scope. Flywheel fails closed; fix the provider's scope handling or perform a fresh owner authorization. No provider-specific exception is built in.
