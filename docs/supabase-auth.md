# Supabase human identity and tenant isolation

Set `TOOLTUNER_AUTH_MODE=supabase`, an exact HTTPS `SUPABASE_URL`, the project's `SUPABASE_PUBLISHABLE_KEY` (`sb_publishable_...`), and a fixed HTTPS gateway origin (automatically selected from trusted hosted Vercel metadata, or explicitly set with `TOOLTUNER_PUBLIC_ORIGIN`; see [configuration](configuration.md)). Do not configure `TOOLTUNER_OWNER_SECRET` in this mode. Missing or invalid Supabase configuration fails startup; provider failures never fall back to shared owner authentication. Only publishable keys are accepted, not secret or legacy service-role keys.

## Identity and authorization

Supabase authenticates humans; the gateway remains the MCP OAuth authorization server. Existing Supabase users sign in with email/password or Google, then separately select an explicitly provisioned grant. Google identity login, downstream MCP dynamic client registration, and upstream MCP account linking are three independent flows.

The verified Supabase user UUID is the new record `owner_id`. The human subject is `supabase:<UUID>`, distinct from an MCP client ID. Email, user metadata, request parameters, and claimed owner headers never choose a tenant. Grant selection, issued codes, token families, access tokens and refresh tokens preserve this identity. Refresh cannot select another owner's grant. The gateway rereads the live grant on MCP requests, so revocation is immediate.

New users have no grants, applications, connections, credentials or traces automatically. Legacy owner records remain in their existing namespaces; signing in does not migrate or claim them. Existing legacy tokens without a valid UUID/human-subject binding fail closed in Supabase mode. Operator commands can target the exact UUID with `TOOLTUNER_OWNER_ID`; they remain trusted administrative commands, not a public user API. Provision upstream accounts, bindings, application registrations and narrowly scoped grants under that same UUID. Do not grant management or wildcard capabilities merely because a user can sign in.

Multiuser runtime disables local job runners and global-owner fixture seeding. Existing graph reads and dispatch derive their owner from the verified MCP principal; credential targets derive from that owner's exact registry binding. PostgreSQL custody additionally requires the restricted role/RLS configuration described in the custody documentation. A backend compromise remains outside the RLS threat model because the trusted backend selects its own verified tenant context.

## Browser flow

The server presents only login and consent pages. Each request receives a random, HttpOnly, Secure, SameSite=Lax browser cookie whose hash is stored with the pending request. Password and Google initiation require a same-origin POST and matching CSRF/browser nonce. Google uses S256 PKCE and the exact callback URL; its callback attempt is consumed durably before code exchange, including across instances. Approval requires the same browser, live Supabase identity, persisted user UUID, and one-time grant selection token.

Supabase requests use a fixed configured origin, bounded input/response size and timeout, and reject HTTP redirects. The server verifies identity through the project's authenticated `/auth/v1/user` endpoint, not decoded JWT claims or unverified browser session data. Anonymous, unconfirmed, and malformed users are rejected. Provider error bodies, passwords, access tokens and provider tokens never appear in page errors or logs.

Login cookies are isolated per authorization request and expire after at most ten minutes or the token response's remaining lifetime, whichever is shorter. Refresh/provider tokens are not retained. There is intentionally no persistent signed-in dashboard or automatic browser session refresh: expired or interrupted authorization requires restarting from the MCP client. Cookies are cleared after completed consent; `/auth/logout` clears the current flow using a same-origin nonce-protected POST. Auth responses are not cacheable. No service-role API or signing secret is used.

## Provider setup (operator action, not performed by this change)

1. Enable email/password for existing users in the intended Supabase project. Google account creation follows the project's existing signup settings; this application does not override that policy or automatically grant new accounts access. This change does not choose a public-signup policy or send invitations, verification emails, or password-reset emails. Recovery and self-service signup UI are not implemented.
2. Configure Google as a Web OAuth client, using the exact Supabase callback shown in its provider configuration. Store the Google client secret only in Supabase's secure provider settings, not the gateway or repository.
3. Configure the gateway's exact `/auth/callback` redirect in Supabase's redirect allowlist, including the request query pattern supported by the provider. Keep production host/path constraints exact; do not allow arbitrary hosts or user-controlled return URLs. The application adds only an opaque `request_id` query parameter. Confirm callback matching in the actual project before enabling production traffic.
4. Use only identity scopes (openid, email, profile). Configure Google audience/test users and publishing requirements as applicable. Future login providers require explicit enablement and an allowlisted button/route; the current route accepts only Google.
5. Verify email/password and Google browser login on the actual hosted origin, followed by distinct user grants and negative cross-user tests. Configuration alone is not evidence of a working provider.

Creating OAuth clients, adding credentials, changing live Auth settings or database roles/policies, and deployment configuration require separate authorized setup. No such changes are performed by this code.

## Lifecycle limitation

Signing out of this browser authorization request does not revoke previously authorized MCP clients. Supabase user deletion, bans, password changes and session revocation are not automatically synchronized with existing gateway MCP grants or 30-day refresh-token families. When disabling an account, the operator must also revoke every gateway grant for that UUID; disabling only Supabase login is insufficient. Automatic lifecycle synchronization and a user-facing client/session management page are not implemented. This is login integration and tenant isolation, not a complete account-administration system.

## References and verification boundary

- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/social-login/auth-google
- https://supabase.com/docs/guides/auth/sessions/pkce-flow
- https://supabase.com/docs/reference/javascript/auth-getuser
- https://supabase.com/docs/guides/auth/server-side/advanced-guide

Synthetic tests exercise provider error handling, browser/CSRF binding, two-user grant isolation, human-subject propagation, legacy token rejection and refresh/revocation boundaries. They do not establish Google configuration, live Supabase authentication, production email delivery or a deployed migration.
