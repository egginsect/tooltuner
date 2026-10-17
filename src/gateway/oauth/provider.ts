/**
 * Flywheel OAuth authorization server provider (TOO-77).
 *
 * Built on the MCP SDK's maintained handlers: metadata, dynamic client
 * registration, authorization code + PKCE (verified by the SDK), token,
 * refresh and revocation. This module only supplies storage, owner consent
 * and grant binding. Tokens are opaque random values bound to one resource,
 * client and grant; refresh never widens the grant.
 */
import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import type { Response } from "express";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, InvalidRequestError, TemporarilyUnavailableError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Grant, Principal } from "../../contracts.js";
import type { GraphClient } from "../../db/client.js";
import * as store from "../../db/auth.js";
import { renderConsentPage, renderOwnerLoginPage, renderConsentError } from "./consent.js";

export const FLYWHEEL_SCOPE = "flywheel";
export const ACCESS_TTL_SEC = 3600;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;
const CODE_TTL_SEC = 300;
const PENDING_TTL_MS = 10 * 60_000;
const SELECTION_TTL_MS = 5 * 60_000;

export interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  resource: string;
  expiresAt: number;
  selectionHash?: string;
  selectionExpiresAt?: number;
}

export interface ProviderOptions {
  db: GraphClient;
  ownerId: string;
  /** The single protected resource (`<public origin>/mcp`). */
  resource: string;
  /** Owner consent secret from the environment; never logged or rendered. */
  ownerSecret: string | undefined;
  now?: () => number;
}

export interface AuthExtra {
  principal: Principal;
}

const randomToken = (): string => randomBytes(32).toString("base64url");

/** Validate the actual serialized URI, not only the SDK's loopback match. */
export function isSafeOAuthRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    const authority = uri.split("://")[1]?.split(/[/?#]/, 1)[0];
    return !/[\u0000-\u0020\u007f]/.test(uri) && !uri.includes("#") && !authority?.includes("@") &&
      !u.username && !u.password && (u.protocol === "https:" ||
        (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)));
  } catch { return false; }
}

export class FlywheelOAuthProvider implements OAuthServerProvider {
  readonly #db: GraphClient;
  readonly #opts: ProviderOptions;
  readonly #pending = new Map<string, PendingAuthorization>();
  readonly #now: () => number;

  constructor(opts: ProviderOptions) {
    this.#db = opts.db;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.#db;
    return {
      async getClient(clientId) {
        return ((await store.getClient(db, clientId)) as OAuthClientInformationFull | null) ?? undefined;
      },
      async registerClient(client) {
        // Public clients use SDK PKCE; never persist a plaintext client secret.
        if (client.token_endpoint_auth_method !== "none") {
          throw new InvalidClientMetadataError('Register a public PKCE client with token_endpoint_auth_method "none"');
        }
        if (client.redirect_uris.some((uri) => !isSafeOAuthRedirect(uri))) {
          throw new InvalidClientMetadataError("Redirect URIs must use HTTPS or loopback HTTP, without credentials or fragments");
        }
        const full: OAuthClientInformationFull = {
          ...client,
          client_secret: undefined,
          client_secret_expires_at: undefined,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        await store.insertClient(db, full.client_id, full);
        return full;
      },
    };
  }

  /** Resource indicator must name this server's resource; absent means this resource. */
  #checkResource(resource: URL | undefined): string {
    const expected = this.#opts.resource;
    if (resource === undefined) return expected;
    if (resource.href !== expected) {
      throw new InvalidTargetError("The resource must identify this server's MCP endpoint");
    }
    return expected;
  }

  /** Step 1: authenticate the owner before reading or displaying grant metadata. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // SDK loopback matching relaxes more than ports. Reject unsafe requests
    // directly: throwing here would make its handler redirect to the unsafe URI.
    if (!isSafeOAuthRedirect(params.redirectUri) || !client.redirect_uris.some((uri) => isSafeOAuthRedirect(uri) && redirectUriMatches(params.redirectUri, uri))) {
      res.status(400).set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
        .type("html").send(renderConsentError("Invalid callback. Use a registered HTTPS or loopback HTTP callback without credentials or fragments."));
      return;
    }
    const resource = this.#checkResource(params.resource);
    if ((params.scopes ?? []).some((scope) => scope !== FLYWHEEL_SCOPE)) throw new InvalidScopeError("Only the flywheel scope is supported");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError("A valid S256 PKCE challenge is required");
    this.#sweep();
    if (this.#pending.size >= 1000) throw new TemporarilyUnavailableError("Too many pending authorization requests; retry later");
    const requestId = randomToken();
    this.#pending.set(requestId, { client, params, resource, expiresAt: this.#now() + PENDING_TTL_MS });
    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
      .send(renderOwnerLoginPage({ requestId, client, resource, ownerSecretConfigured: !!this.#opts.ownerSecret }));
  }

  /** Step 2: the owner secret is used only here, never copied into a page or URL. */
  async authenticateOwner(input: { requestId: string; ownerSecret: string }): Promise<{ html: string } | { error: string; status: number }> {
    const pending = this.#pending.get(input.requestId);
    if (!pending || pending.expiresAt <= this.#now() || pending.selectionHash !== undefined) {
      return { status: 400, error: "This login request expired or was already used. Restart the connection from your client." };
    }
    if (!this.#secretMatches(input.ownerSecret)) {
      return { status: 403, error: "Owner secret is incorrect. Go back and try again." };
    }
    // Claim login before awaiting storage so concurrent login cannot create two capabilities.
    this.#pending.delete(input.requestId);
    const grants = (await store.listGrants(this.#db, this.#opts.ownerId)).filter((g) => g.revoked_at === null);
    if (pending.expiresAt <= this.#now()) return { status: 400, error: "Authorization expired. Restart the connection from your client." };
    const selectionToken = randomToken();
    this.#pending.set(input.requestId, { ...pending, selectionHash: store.hashSecret(selectionToken),
      selectionExpiresAt: Math.min(pending.expiresAt, this.#now() + SELECTION_TTL_MS) });
    return { html: renderConsentPage({ requestId: input.requestId, selectionToken, client: pending.client,
      resource: pending.resource, redirectUri: pending.params.redirectUri, grants }) };
  }

  /** Step 3: consume the request-bound selection capability and issue one code. */
  async completeConsent(input: {
    requestId: string;
    grantId: string;
    selectionToken?: string;
    approve: boolean;
  }): Promise<{ redirectTo: string } | { error: string; status: number }> {
    const pending = this.#pending.get(input.requestId);
    if (!pending || pending.expiresAt <= this.#now()) {
      this.#pending.delete(input.requestId);
      return { status: 400, error: "This authorization request expired. Restart the connection from your client." };
    }
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined) redirect.searchParams.set("state", pending.params.state);
    if (!input.approve) {
      this.#pending.delete(input.requestId);
      redirect.searchParams.set("error", "access_denied");
      return { redirectTo: redirect.href };
    }
    if (!pending.selectionHash || pending.selectionExpiresAt === undefined || pending.selectionExpiresAt <= this.#now() ||
      !input.selectionToken || !timingSafeEqual(Buffer.from(store.hashSecret(input.selectionToken), "hex"), Buffer.from(pending.selectionHash, "hex"))) {
      return { status: 403, error: "Grant selection requires owner login. Restart the connection if your selection page expired." };
    }
    // Claim this browser request before awaiting storage, preventing double approval.
    this.#pending.delete(input.requestId);
    const grant = await store.getGrant(this.#db, input.grantId);
    if (!grant || grant.owner_id !== this.#opts.ownerId || grant.revoked_at !== null) {
      return { status: 400, error: "Choose an active grant owned by this server. Restart the connection to try again." };
    }
    const code = randomToken();
    await store.insertCode(this.#db, code, {
      family_id: randomUUID(),
      client_id: pending.client.client_id,
      grant_id: grant.grant_id,
      redirect_uri: pending.params.redirectUri,
      code_challenge: pending.params.codeChallenge,
      resource: pending.resource,
      scopes: [FLYWHEEL_SCOPE],
      expires_at: Math.floor(this.#now() / 1000) + CODE_TTL_SEC,
    });
    redirect.searchParams.set("code", code);
    return { redirectTo: redirect.href };
  }

  #secretMatches(candidate: string): boolean {
    const expected = this.#opts.ownerSecret;
    if (!expected) return false;
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, p] of this.#pending) if (p.expiresAt <= now || (p.selectionExpiresAt !== undefined && p.selectionExpiresAt <= now)) this.#pending.delete(id);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const stored = await store.peekCode(this.#db, code);
    if (!stored || stored.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return stored.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const nowSec = Math.floor(this.#now() / 1000);
    const stored = await store.consumeCode(this.#db, code, nowSec);
    if (!stored || stored.client_id !== client.client_id) {
      const prior = await store.peekCode(this.#db, code);
      if (prior?.client_id === client.client_id) await store.revokeFamily(this.#db, prior.family_id, nowSec);
      throw new InvalidGrantError("Authorization code is invalid, expired, or already used");
    }
    if (redirectUri !== stored.redirect_uri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.#checkResource(new URL(stored.resource));
    if (resource !== undefined && this.#checkResource(resource) !== stored.resource) {
      throw new InvalidTargetError("resource does not match the authorization request");
    }
    return this.#issue(stored.client_id, stored.grant_id, stored.family_id, stored.resource, stored.scopes);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const stored = await store.getToken(this.#db, refreshToken);
    const nowSec = Math.floor(this.#now() / 1000);
    if (!stored || stored.kind !== "refresh" || stored.client_id !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (stored.revoked) {
      // Reuse of a rotated token: assume theft and end the whole session.
      await store.revokeFamily(this.#db, stored.family_id, nowSec);
      throw new InvalidGrantError("Refresh token was already used; the session has been revoked");
    }
    if (stored.expires_at <= nowSec) throw new InvalidGrantError("Refresh token expired; reconnect to consent again");
    if (scopes && scopes.some((s) => !stored.scopes.includes(s))) {
      throw new InvalidScopeError("Refresh cannot widen scopes");
    }
    this.#checkResource(new URL(stored.resource));
    if (resource !== undefined && this.#checkResource(resource) !== stored.resource) {
      throw new InvalidTargetError("Refresh cannot change the resource");
    }
    const grant = await store.getGrant(this.#db, stored.grant_id);
    if (!grant || grant.owner_id !== this.#opts.ownerId || grant.revoked_at !== null) throw new InvalidGrantError("The grant behind this session was revoked");
    return this.#issue(stored.client_id, stored.grant_id, stored.family_id, stored.resource, scopes ?? stored.scopes, refreshToken);
  }

  async #issue(clientId: string, grantId: string, familyId: string, resource: string, scopes: string[], previousRefresh?: string): Promise<OAuthTokens> {
    const nowSec = Math.floor(this.#now() / 1000);
    const access = randomToken();
    const refresh = randomToken();
    const base = { client_id: clientId, grant_id: grantId, family_id: familyId, resource, scopes };
    const issued = await store.issueTokenPair(this.#db, access, refresh, base, this.#opts.ownerId,
      nowSec, nowSec + ACCESS_TTL_SEC, nowSec + REFRESH_TTL_SEC, previousRefresh);
    if (!issued) {
      await store.revokeFamily(this.#db, familyId, nowSec);
      throw new InvalidGrantError("The grant or session is no longer active; reconnect to consent again");
    }
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: ACCESS_TTL_SEC,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  /** Checked on every MCP request: token, expiry, resource, and a live grant. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = await store.getToken(this.#db, token);
    const nowSec = Math.floor(this.#now() / 1000);
    if (!stored || stored.kind !== "access" || stored.revoked) throw new InvalidTokenError("Invalid access token");
    if (stored.expires_at <= nowSec) throw new InvalidTokenError("Access token expired");
    if (stored.resource !== this.#opts.resource) throw new InvalidTokenError("Token was issued for another resource");
    const grant = await store.getGrant(this.#db, stored.grant_id);
    if (!grant || grant.owner_id !== this.#opts.ownerId || grant.revoked_at !== null) throw new InvalidTokenError("The grant behind this token was revoked");
    const principal: Principal = {
      owner_id: grant.owner_id,
      subject: `owner:${grant.owner_id}`,
      client_id: stored.client_id,
      grant_id: grant.grant_id,
      session_id: stored.family_id,
    };
    return {
      token,
      clientId: stored.client_id,
      scopes: stored.scopes,
      expiresAt: stored.expires_at,
      resource: new URL(stored.resource),
      extra: { principal } satisfies AuthExtra,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const stored = await store.getToken(this.#db, request.token);
    // RFC 7009: unknown tokens and other clients' tokens are silently ignored.
    if (!stored || stored.client_id !== client.client_id) return;
    await store.revokeFamily(this.#db, stored.family_id, Math.floor(this.#now() / 1000));
  }

  /** Loads the current grant for a verified principal (revocation takes effect immediately). */
  async loadGrant(principal: Principal): Promise<Grant> {
    if (principal.owner_id !== this.#opts.ownerId) throw new InvalidTokenError("Invalid token owner");
    const grant = await store.getGrant(this.#db, principal.grant_id);
    if (!grant || grant.owner_id !== this.#opts.ownerId || grant.revoked_at !== null) throw new InvalidTokenError("The grant behind this token was revoked");
    if (grant.owner_id !== principal.owner_id) throw new InvalidTokenError("Invalid token owner");
    return grant;
  }
}
