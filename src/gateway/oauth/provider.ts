/**
 * ToolTuner OAuth authorization server provider (TOO-77).
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
import { renderConsentPage, renderOwnerLoginPage, renderUserLoginPage, renderConsentError } from "./consent.js";

import { flowCookie, writeCookie } from "../auth/browser.js";
import { UserId } from "../auth/supabase.js";

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
  browserHash?: string;
  ownerId?: string;
  subject?: string;
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
  /** Supabase users own separate UUID namespaces; legacy owner authority is disabled. */
  multiuser?: boolean;
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
  readonly #now: () => number;

  constructor(opts: ProviderOptions) {
    this.#db = opts.db;
    this.#opts = opts;
    this.#now = opts.now ?? Date.now;
  }

  get multiuser(): boolean { return this.#opts.multiuser === true; }
  get #pendingBinding(): store.PendingBinding {
    return { ownerId: this.multiuser ? "supabase-pending" : this.#opts.ownerId, resource: this.#opts.resource };
  }
  #identity(record: { owner_id?: string; subject?: string }): { ownerId: string; subject: string } {
    if (this.multiuser) {
      if (!UserId.safeParse(record.owner_id).success || record.subject !== `supabase:${record.owner_id}`) throw new InvalidTokenError("Invalid tenant identity");
      return { ownerId: record.owner_id!, subject: record.subject! };
    }
    if (record.owner_id !== undefined && record.owner_id !== this.#opts.ownerId) throw new InvalidTokenError("Invalid owner identity");
    return { ownerId: this.#opts.ownerId, subject: `owner:${this.#opts.ownerId}` };
  }
  async checkBrowser(requestId: string, browserToken: string): Promise<boolean> {
    if (!this.multiuser || !/^[A-Za-z0-9_-]{43}$/.test(browserToken)) return false;
    const doc = await store.readPendingAuthorization(this.#db, this.#pendingBinding, requestId, this.#now());
    if (!doc) return false;
    const pending = JSON.parse(doc) as PendingAuthorization;
    return pending.expiresAt > this.#now() && pending.browserHash === store.hashSecret(browserToken);
  }
  async browserOAuth(requestId: string, browserToken: string, verifier: string, claim: boolean): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(verifier) || !await this.checkBrowser(requestId, browserToken)) return false;
    const operation = claim ? store.claimBrowserOAuth : store.beginBrowserOAuth;
    return operation(this.#db, this.#pendingBinding, requestId, this.#now(), store.hashSecret(verifier));
  }
  async authenticateUser(input: { requestId: string; browserToken: string; userId: string }): Promise<{ html: string } | { error: string; status: number }> {
    if (!UserId.safeParse(input.userId).success || !await this.checkBrowser(input.requestId, input.browserToken)) {
      return { status: 403, error: "Sign-in does not match this browser authorization request." };
    }
    return this.#select(input.requestId, input.userId, `supabase:${input.userId}`);
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
    const requestId = randomToken();
    const now = this.#now();
    const browserToken = this.multiuser ? randomToken() : undefined;
    const created = await store.insertPendingAuthorization(this.#db, this.#pendingBinding, requestId,
      JSON.stringify({ client, params, resource, expiresAt: now + PENDING_TTL_MS, ...(browserToken ? { browserHash: store.hashSecret(browserToken) } : {}) }), now + PENDING_TTL_MS, now);
    if (!created) throw new TemporarilyUnavailableError("Too many pending authorization requests; retry later");
    if (browserToken) writeCookie(res, flowCookie(requestId), browserToken);
    res
      .status(200)
      .set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" })
      .send(browserToken ? renderUserLoginPage({ requestId, client, resource, browserToken }) : renderOwnerLoginPage({ requestId, client, resource, ownerSecretConfigured: !!this.#opts.ownerSecret }));
  }

  /** Step 2: the owner secret is used only here, never copied into a page or URL. */
  async authenticateOwner(input: { requestId: string; ownerSecret: string }): Promise<{ html: string } | { error: string; status: number }> {
    if (this.multiuser || !this.#secretMatches(input.ownerSecret)) {
      return { status: 403, error: "Owner secret authentication is unavailable or invalid." };
    }
    return this.#select(input.requestId, this.#opts.ownerId, `owner:${this.#opts.ownerId}`);
  }

  async #select(requestId: string, ownerId: string, subject: string): Promise<{ html: string } | { error: string; status: number }> {
    const document = await store.readPendingAuthorization(this.#db, this.#pendingBinding, requestId, this.#now());
    const pending = document ? JSON.parse(document) as PendingAuthorization : null;
    if (!pending || pending.expiresAt <= this.#now() || pending.selectionHash !== undefined) {
      return { status: 400, error: "This login request expired or was already used. Restart the connection." };
    }
    // Claim login before awaiting storage so concurrent login cannot create two capabilities.
    if (!await store.claimPendingLogin(this.#db, this.#pendingBinding, requestId, this.#now())) {
      return { status: 400, error: "This login request expired or was already used. Restart the connection from your client." };
    }
    const grants = (await store.listGrants(this.#db, ownerId)).filter((g) => g.owner_id === ownerId && g.revoked_at === null);
    if (pending.expiresAt <= this.#now()) return { status: 400, error: "Authorization expired. Restart the connection from your client." };
    const selectionToken = randomToken();
    const selectionHash = store.hashSecret(selectionToken);
    const selectionExpiresAt = Math.min(pending.expiresAt, this.#now() + SELECTION_TTL_MS);
    if (!await store.finishPendingLogin(this.#db, this.#pendingBinding, requestId, this.#now(),
      JSON.stringify({ ...pending, ownerId, subject, selectionHash, selectionExpiresAt }), selectionHash, selectionExpiresAt)) {
      return { status: 400, error: "Authorization expired. Restart the connection from your client." };
    }
    return { html: renderConsentPage({ requestId: requestId, selectionToken, client: pending.client,
      resource: pending.resource, redirectUri: pending.params.redirectUri, grants }) };
  }

  /** Step 3: consume the request-bound selection capability and issue one code. */
  async completeConsent(input: {
    requestId: string;
    grantId: string;
    selectionToken?: string;
    userId?: string;
    browserToken?: string;
    approve: boolean;
  }): Promise<{ redirectTo: string } | { error: string; status: number }> {
    const document = await store.readPendingAuthorization(this.#db, this.#pendingBinding, input.requestId, this.#now());
    const pending = document ? JSON.parse(document) as PendingAuthorization : null;
    if (!pending || pending.expiresAt <= this.#now()) {
      return { status: 400, error: "This authorization request expired. Restart the connection from your client." };
    }
    if (this.multiuser && (!input.userId || pending.ownerId !== input.userId || pending.subject !== `supabase:${input.userId}` ||
        !input.browserToken || !await this.checkBrowser(input.requestId, input.browserToken))) {
      return { status: 403, error: "Consent requires the same signed-in account and browser." };
    }
    const ownerId = this.multiuser ? pending.ownerId! : this.#opts.ownerId;
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state !== undefined) redirect.searchParams.set("state", pending.params.state);
    if (!input.approve) {
      if (!await store.consumePendingAuthorization(this.#db, this.#pendingBinding, input.requestId, this.#now(), false, "")) {
        return { status: 400, error: "Authorization expired or was already used. Restart the connection from your client." };
      }
      redirect.searchParams.set("error", "access_denied");
      return { redirectTo: redirect.href };
    }
    if (!pending.selectionHash || pending.selectionExpiresAt === undefined || pending.selectionExpiresAt <= this.#now() ||
      !input.selectionToken || !timingSafeEqual(Buffer.from(store.hashSecret(input.selectionToken), "hex"), Buffer.from(pending.selectionHash, "hex"))) {
      return { status: 403, error: "Grant selection requires owner login. Restart the connection if your selection page expired." };
    }
    // Claim this browser request before awaiting storage, preventing double approval.
    if (!await store.consumePendingAuthorization(this.#db, this.#pendingBinding, input.requestId, this.#now(), true, store.hashSecret(input.selectionToken))) {
      return { status: 400, error: "Authorization expired or was already used. Restart the connection from your client." };
    }
    const grant = await store.getGrant(this.#db, input.grantId);
    if (!grant || grant.owner_id !== ownerId || grant.revoked_at !== null) {
      return { status: 400, error: "Choose an active grant owned by this server. Restart the connection to try again." };
    }
    const code = randomToken();
    await store.insertCode(this.#db, code, {
      owner_id: ownerId, subject: pending.subject ?? `owner:${ownerId}`,
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

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const stored = await store.peekCode(this.#db, code);
    if (!stored || stored.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    this.#identity(stored);
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
    const identity = this.#identity(stored);
    return this.#issue(stored.client_id, stored.grant_id, stored.family_id, stored.resource, stored.scopes, identity);
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
    const identity = this.#identity(stored);
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
    if (!grant || grant.owner_id !== identity.ownerId || grant.revoked_at !== null) throw new InvalidGrantError("The grant behind this session was revoked");
    return this.#issue(stored.client_id, stored.grant_id, stored.family_id, stored.resource, scopes ?? stored.scopes, identity, refreshToken);
  }

  async #issue(clientId: string, grantId: string, familyId: string, resource: string, scopes: string[], identity: { ownerId: string; subject: string }, previousRefresh?: string): Promise<OAuthTokens> {
    const nowSec = Math.floor(this.#now() / 1000);
    const access = randomToken();
    const refresh = randomToken();
    const base = { owner_id: identity.ownerId, subject: identity.subject, client_id: clientId, grant_id: grantId, family_id: familyId, resource, scopes };
    const issued = await store.issueTokenPair(this.#db, access, refresh, base, identity.ownerId,
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
    const identity = this.#identity(stored);
    const grant = await store.getGrant(this.#db, stored.grant_id);
    if (!grant || grant.owner_id !== identity.ownerId || grant.revoked_at !== null) throw new InvalidTokenError("The grant behind this token was revoked");
    const principal: Principal = {
      owner_id: grant.owner_id,
      subject: identity.subject,
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
    this.#identity(stored);
    await store.revokeFamily(this.#db, stored.family_id, Math.floor(this.#now() / 1000));
  }

  /** Loads the current grant for a verified principal (revocation takes effect immediately). */
  async loadGrant(principal: Principal): Promise<Grant> {
    const identity = this.#identity(principal);
    const grant = await store.getGrant(this.#db, principal.grant_id);
    if (!grant || grant.owner_id !== identity.ownerId || grant.revoked_at !== null) throw new InvalidTokenError("The grant behind this token was revoked");
    if (grant.owner_id !== principal.owner_id) throw new InvalidTokenError("Invalid token owner");
    return grant;
  }
}
