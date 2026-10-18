import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauth from "@modelcontextprotocol/sdk/client/auth.js";
import type { GraphClient } from "../../src/db/client.js";
import * as registry from "../../src/db/registry.js";
import { CredentialBinding, UpstreamAccount } from "../../src/db/registry.js";
import {
  OAuthCredential, acquisitionProvenance, authorizeCredential, credentialFetch, discoverAccountIssuer,
  validateStandardTokens, type CredentialStore,
} from "../../src/gateway/credentials.js";
import { readUpstreamCatalog } from "../../src/gateway/upstream.js";
import { beginUpstreamAccountLink, linkUpstreamAccount, verifyResourceMetadata, type LinkOptions } from "../../src/cli/link.js";
import { beginDeviceAccountLink } from "../../src/cli/device-link.js";

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth.js")>(),
  discoverAuthorizationServerMetadata: vi.fn(), discoverOAuthProtectedResourceMetadata: vi.fn(),
  refreshAuthorization: vi.fn(), registerClient: vi.fn(), startAuthorization: vi.fn(), exchangeAuthorization: vi.fn(),
}));
vi.mock("../../src/db/registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/db/registry.js")>(),
  getUpstreamAccount: vi.fn(), putUpstreamAccount: vi.fn(), putCredentialBinding: vi.fn(),
}));
vi.mock("../../src/gateway/upstream.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/gateway/upstream.js")>(), readUpstreamCatalog: vi.fn(),
}));

// All values are synthetic. Network, SDK discovery/exchange, graph persistence and
// protected-resource initialization are replaced at their external boundaries.
const NOW = Date.parse("2026-10-18T12:00:00Z");
const issuer = "https://issuer.example";
const resource = "https://mcp.example/deployment-a/mcp";
const db = {} as GraphClient;
const metadata = {
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`, device_authorization_endpoint: `${issuer}/device`,
  response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
};

function fixture() {
  const account = UpstreamAccount.parse({ schema_version: 1, owner_id: "owner", created_at: new Date(NOW).toISOString(),
    auth_config_ref: "test:standard", credential_ref: "postgres:synthetic", application: "textkit", repo_id: "test/repo",
    environment: "production", issuer, client_id: "synthetic-client", scopes: ["mcp:read"], validation_mode: "standard_oauth" });
  const binding = CredentialBinding.parse({ schema_version: 1, owner_id: account.owner_id, created_at: account.created_at,
    auth_config_ref: account.auth_config_ref, application: account.application, repo_id: account.repo_id,
    commit_sha: "a".repeat(40), deployment_id: "deployment-a", url: resource, resource, audience: resource,
    environment: account.environment, issuer, scopes: account.scopes });
  return { account, binding, secret: credential(account, binding) };
}

function credential(account: UpstreamAccount, binding: CredentialBinding): OAuthCredential {
  return OAuthCredential.parse({ issuer: account.issuer, environment: account.environment, resource: binding.resource,
    audience: binding.audience, obtained_at: Math.floor(Date.now() / 1000),
    client: { client_id: account.client_id, issuer: account.issuer, token_endpoint_auth_method: "none" },
    tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer", expires_in: 3600,
      issuer: account.issuer, scope: account.scopes.join(" ") }, acquisition: acquisitionProvenance(account, binding) });
}

function credentialStore(initial: OAuthCredential) {
  let stored = structuredClone(initial);
  let fenced = false;
  return {
    custody: "encrypted_postgres" as const,
    get: vi.fn(async (_reference: string, _binding?: CredentialBinding): Promise<unknown> => {
      if (fenced) throw new Error("Synthetic durable refresh fence is closed");
      return structuredClone(stored);
    }),
    put: vi.fn(async (_reference: string, value: unknown, _binding?: CredentialBinding) => {
      stored = OAuthCredential.parse(value);
      fenced = false;
    }),
    beginRefresh: vi.fn(async () => { fenced = true; }),
    isFenced: () => fenced,
  };
}

function linkOptions(store: CredentialStore): LinkOptions {
  const { account, binding } = fixture();
  return { db, owner: { owner_id: "owner", subject: "local-owner" }, store,
    account: { auth_config_ref: account.auth_config_ref, credential_ref: account.credential_ref,
      application: account.application, repo_id: account.repo_id, environment: account.environment,
      issuer: account.issuer, scopes: account.scopes, validation_mode: account.validation_mode },
    target: { commit_sha: binding.commit_sha, deployment_id: binding.deployment_id, url: binding.url,
      resource: binding.resource, audience: binding.audience } };
}

function nearExpiry(secret: OAuthCredential): OAuthCredential {
  return { ...secret, tokens: { ...secret.tokens, expires_in: 10 } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in unit test"); }));
  vi.mocked(oauth.discoverAuthorizationServerMetadata).mockResolvedValue(metadata);
  vi.mocked(oauth.discoverOAuthProtectedResourceMetadata).mockResolvedValue({ resource, authorization_servers: [issuer] });
  vi.mocked(oauth.registerClient).mockResolvedValue({ client_id: "synthetic-client", redirect_uris: [], token_endpoint_auth_method: "none" });
  vi.mocked(oauth.refreshAuthorization).mockResolvedValue({ access_token: "synthetic-refreshed-access", token_type: "Bearer", expires_in: 3600 });
  vi.mocked(registry.getUpstreamAccount).mockResolvedValue(null);
  vi.mocked(registry.putUpstreamAccount).mockImplementation(async (_db, account) => account);
  vi.mocked(registry.putCredentialBinding).mockImplementation(async (_db, binding) => binding);
  vi.mocked(readUpstreamCatalog).mockResolvedValue([]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("explicit standard OAuth and legacy compatibility", () => {
  it("uses protected-resource acceptance without introspection only for explicit standard mode", async () => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(secret);
    expect(await authorizeCredential(account, binding, store)).toEqual({ Authorization: "Bearer synthetic-access" });
    expect(fetch).not.toHaveBeenCalled();
    expect(oauth.refreshAuthorization).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).toHaveBeenCalledOnce();
    const [target, options] = vi.mocked(readUpstreamCatalog).mock.calls[0]!;
    expect(target.runtime_target.url).toBe(binding.resource);
    expect(await options!.resolveAuth!(account.auth_config_ref, target)).toEqual({ Authorization: "Bearer synthetic-access" });
  });

  it.each([undefined, "introspection"] as const)("keeps %s mode on authoritative introspection", async (mode) => {
    const { account, binding, secret } = fixture();
    const legacy = { ...account, validation_mode: mode, introspection_url: `${issuer}/introspect` };
    delete secret.acquisition;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ active: true, aud: resource, client_id: account.client_id,
      scope: "mcp:read", iss: issuer, exp: NOW / 1000 + 300 }), { status: 200 }));
    const store: CredentialStore = { get: vi.fn().mockResolvedValue(secret) };
    expect(await authorizeCredential(legacy, binding, store)).toEqual({ Authorization: "Bearer synthetic-access" });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${issuer}/introspect`);
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("does not silently infer standard mode from an absent introspection endpoint", async () => {
    const { account, binding, secret } = fixture();
    delete account.validation_mode;
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("rejects imported standard-mode tokens before reading or persisting credentials", async () => {
    const { secret } = fixture();
    const store = credentialStore(secret);
    await expect(linkUpstreamAccount(linkOptions(store))).rejects.toThrow(/cannot import tokens/);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
    expect(registry.putUpstreamAccount).not.toHaveBeenCalled();
  });

  it("requires encrypted custody even when an imported document contains plausible provenance", async () => {
    const { account, binding, secret } = fixture();
    await expect(authorizeCredential(account, binding, { get: vi.fn().mockResolvedValue(secret) })).rejects.toThrow(/encrypted PostgreSQL/);
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("rejects browser acquisition outside encrypted PostgreSQL before SDK discovery", async () => {
    const { secret } = fixture();
    const options = linkOptions({ get: vi.fn().mockResolvedValue(secret), put: vi.fn() });
    options.account.credential_ref = "helper:synthetic";
    await expect(beginUpstreamAccountLink({ ...options, onAuthorizationUrl: vi.fn() })).rejects.toThrow(/encrypted PostgreSQL/);
    expect(oauth.discoverOAuthProtectedResourceMetadata).not.toHaveBeenCalled();
    expect(oauth.startAuthorization).not.toHaveBeenCalled();
  });

  it("fails closed when the exact protected resource rejects the acquired bearer", async () => {
    const { account, binding, secret } = fixture();
    vi.mocked(readUpstreamCatalog).mockRejectedValue(new Error("Synthetic protected resource denied initialization"));
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toThrow(/denied initialization/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("standard OAuth provenance and exact authority", () => {
  it("rejects missing acquisition provenance before refresh or resource access", async () => {
    const { account, binding, secret } = fixture();
    delete secret.acquisition;
    await expect(authorizeCredential(account, binding, credentialStore(nearExpiry(secret)))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(oauth.refreshAuthorization).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it.each(["authority_digest", "binding_digest"] as const)("rejects altered %s", async (field) => {
    const { account, binding, secret } = fixture();
    secret.acquisition![field] = "sha256:synthetic-other-digest";
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ["owner_id", "other-owner"], ["application", "other-app"], ["repo_id", "other/repo"],
    ["auth_config_ref", "test:other"], ["environment", "preview"], ["issuer", "https://other-issuer.example"],
    ["commit_sha", "b".repeat(40)], ["deployment_id", "other-deployment"],
  ])("does not replay provenance after changing binding %s", async (field, value) => {
    const { account, binding, secret } = fixture();
    const changed = { ...binding, [field!]: value };
    await expect(authorizeCredential(account, changed, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
    expect(oauth.refreshAuthorization).not.toHaveBeenCalled();
  });

  it.each(["url", "resource", "audience"] as const)("requires an exact MCP URL/resource/audience match for %s", async (field) => {
    const { account, binding, secret } = fixture();
    binding[field] = "https://mcp.example/other/mcp";
    secret.acquisition = acquisitionProvenance(account, binding);
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(oauth.refreshAuthorization).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it.each(["resource", "audience"] as const)("rejects a secret for another %s rather than refreshing it into this binding", async (field) => {
    const { account, binding, secret } = fixture();
    secret[field] = "https://mcp.example/other/mcp";
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(oauth.refreshAuthorization).not.toHaveBeenCalled();
  });

  it.each(["credential_issuer", "client_issuer", "token_issuer", "client_id"] as const)("rejects mismatched %s before resource access", async (field) => {
    const { account, binding, secret } = fixture();
    if (field === "credential_issuer") secret.issuer = "https://other-issuer.example";
    else if (field === "client_id") secret.client.client_id = "synthetic-other-client";
    else if (field === "client_issuer") secret.client.issuer = "https://other-issuer.example";
    else secret.tokens.issuer = "https://other-issuer.example";
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("omits creation timestamps from stable provenance while retaining authority fields", () => {
    const { account, binding, secret } = fixture();
    account.created_at = "2026-10-19T12:00:00.000Z";
    binding.created_at = account.created_at;
    expect(() => validateStandardTokens(account, binding, secret)).not.toThrow();
    account.credential_ref = "postgres:another-reference";
    expect(() => validateStandardTokens(account, binding, secret)).toThrow(/provenance/);
  });

  it.each(["future_acquisition", "acquisition_after_obtained", "future_obtained"] as const)("rejects inconsistent provenance time: %s", (fault) => {
    const { account, binding, secret } = fixture();
    if (fault === "future_acquisition") secret.acquisition!.acquired_at += 60;
    if (fault === "acquisition_after_obtained") secret.obtained_at -= 1;
    if (fault === "future_obtained") secret.obtained_at += 60;
    expect(() => validateStandardTokens(account, binding, secret)).toThrow(/provenance/);
  });
});

describe("standard OAuth scope and token semantics", () => {
  it("inherits requested acquisition scopes only when the initial response omits scope", async () => {
    const { account, binding, secret } = fixture();
    delete secret.tokens.scope;
    expect(await authorizeCredential(account, binding, credentialStore(secret))).toEqual({ Authorization: "Bearer synthetic-access" });
  });

  it.each(["", "   ", "mcp:write", "mcp:read mcp:write"])("rejects explicit empty, insufficient or expanded scopes: %j", async (scope) => {
    const { account, binding, secret } = fixture();
    secret.tokens.scope = scope;
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("rejects provenance scopes that differ from the approved account", () => {
    const { account, binding, secret } = fixture();
    secret.acquisition!.scopes.push("mcp:write");
    expect(() => validateStandardTokens(account, binding, secret)).toThrow(/approved scopes/);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid token lifetime %s", (expires_in) => {
    const { account, binding, secret } = fixture();
    secret.tokens.expires_in = expires_in;
    expect(() => validateStandardTokens(account, binding, secret)).toThrow(/token lifetime/);
  });

  it("rejects non-Bearer tokens", async () => {
    const { account, binding, secret } = fixture();
    secret.tokens.token_type = "MAC";
    await expect(authorizeCredential(account, binding, credentialStore(secret))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });
});

describe("resource-bound refresh and fail-closed custody", () => {
  it("fences before refresh, carries the exact resource and preserves an omitted scope and refresh token", async () => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(nearExpiry(secret));
    vi.mocked(oauth.refreshAuthorization).mockImplementation(async (_issuer, options) => {
      expect(store.isFenced()).toBe(true);
      expect(options.resource).toBe(binding.resource);
      expect(options.refreshToken).toBe("synthetic-refresh");
      return { access_token: "synthetic-refreshed-access", token_type: "Bearer", expires_in: 3600 };
    });
    expect(await authorizeCredential(account, binding, store)).toEqual({ Authorization: "Bearer synthetic-refreshed-access" });
    expect(store.beginRefresh).toHaveBeenCalledOnce();
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.put.mock.calls[0]![1]).toMatchObject({ acquisition: secret.acquisition,
      tokens: { scope: "mcp:read", refresh_token: "synthetic-refresh", issuer } });
    expect(store.isFenced()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("inherits prior granted scopes rather than reinterpreting omission as all account scopes", async () => {
    const { account, binding } = fixture();
    account.scopes = ["mcp:read", "mcp:write"];
    const secret = nearExpiry(credential(account, binding));
    secret.tokens.scope = "mcp:read";
    const store = credentialStore(secret);
    await authorizeCredential(account, binding, store);
    expect(store.put.mock.calls[0]![1]).toMatchObject({ tokens: { scope: "mcp:read" } });
  });

  it("rejects refresh expansion beyond the prior grant even inside approved account scopes", async () => {
    const { account, binding } = fixture();
    account.scopes = ["mcp:read", "mcp:write"];
    const secret = nearExpiry(credential(account, binding));
    secret.tokens.scope = "mcp:read";
    const store = credentialStore(secret);
    vi.mocked(oauth.refreshAuthorization).mockResolvedValue({ access_token: "synthetic-refreshed-access", token_type: "Bearer",
      expires_in: 3600, scope: "mcp:read mcp:write" });
    await expect(authorizeCredential(account, binding, store)).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(store.isFenced()).toBe(true);
    expect(store.put).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("uses acquisition scopes when both the original and refreshed responses omit scope", async () => {
    const { account, binding, secret } = fixture();
    delete secret.tokens.scope;
    const store = credentialStore(nearExpiry(secret));
    await authorizeCredential(account, binding, store);
    expect(store.put.mock.calls[0]![1]).toMatchObject({ tokens: { scope: "mcp:read" } });
  });

  it.each(["", "   ", "mcp:write", "mcp:read mcp:write"])("keeps the fence closed after invalid refreshed scope %j", async (scope) => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(nearExpiry(secret));
    vi.mocked(oauth.refreshAuthorization).mockResolvedValue({ access_token: "synthetic-refreshed-access", token_type: "Bearer", expires_in: 3600, scope });
    await expect(authorizeCredential(account, binding, store)).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(store.isFenced()).toBe(true);
    expect(store.put).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
    await expect(authorizeCredential(account, binding, store)).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(oauth.refreshAuthorization).toHaveBeenCalledOnce();
  });

  it.each(["issuer", "token_type", "expires_in"] as const)("retains the refresh fence after an invalid %s response", async (field) => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(nearExpiry(secret));
    vi.mocked(oauth.refreshAuthorization).mockResolvedValue({ access_token: "synthetic-refreshed-access", token_type: "Bearer", expires_in: 3600,
      ...({ issuer: { issuer: "https://other-issuer.example" }, token_type: { token_type: "MAC" }, expires_in: { expires_in: 0 } }[field]) });
    await expect(authorizeCredential(account, binding, store)).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(store.isFenced()).toBe(true);
    expect(store.put).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("does not reuse a rotating refresh token after an uncertain exchange", async () => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(nearExpiry(secret));
    vi.mocked(oauth.refreshAuthorization).mockRejectedValue(new Error("Synthetic remote failure containing a synthetic secret"));
    await expect(authorizeCredential(account, binding, store)).rejects.toThrow(/reconcile the account/);
    await expect(authorizeCredential(account, binding, store)).rejects.toThrow(/external credential is unavailable/);
    expect(store.isFenced()).toBe(true);
    expect(store.put).not.toHaveBeenCalled();
    expect(oauth.refreshAuthorization).toHaveBeenCalledOnce();
  });

  it("does not exchange if the durable fence cannot be written", async () => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(nearExpiry(secret));
    store.beginRefresh.mockRejectedValue(new Error("Synthetic persistence failure"));
    await expect(authorizeCredential(account, binding, store)).rejects.toThrow(/secure token persistence failed/);
    expect(oauth.refreshAuthorization).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("does not return a refreshed bearer when secure persistence fails", async () => {
    const { account, binding, secret } = fixture();
    const store = credentialStore(nearExpiry(secret));
    store.put.mockRejectedValue(new Error("Synthetic persistence failure"));
    await expect(authorizeCredential(account, binding, store)).rejects.toThrow(/secure token persistence failed/);
    expect(store.isFenced()).toBe(true);
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("runs authorization inside the credential store's exclusive session", async () => {
    const { account, binding, secret } = fixture();
    const locked = credentialStore(nearExpiry(secret));
    const get = vi.fn(async () => { throw new Error("Unscoped read must not run"); });
    const exclusive = vi.fn();
    await authorizeCredential(account, binding, { get, custody: "encrypted_postgres",
      exclusive: async (reference, target, work) => { exclusive(reference, target); return work(locked); } });
    expect(exclusive).toHaveBeenCalledExactlyOnceWith(account.credential_ref, binding);
    expect(get).not.toHaveBeenCalled();
    expect(locked.beginRefresh).toHaveBeenCalledOnce();
    expect(locked.put).toHaveBeenCalledOnce();
  });
});

describe("issuer and protected-resource discovery boundaries", () => {
  it("accepts standard protected-resource metadata without optional scopes_supported", async () => {
    const { account, binding } = fixture();
    await expect(verifyResourceMetadata(account, binding)).resolves.toBeUndefined();
    delete account.validation_mode;
    await expect(verifyResourceMetadata(account, binding)).rejects.toThrow(/resource\/scopes/);
  });

  it.each([
    { resource: "https://mcp.example/other/mcp", authorization_servers: [issuer] },
    { resource, authorization_servers: ["https://other-issuer.example"] },
    { resource, authorization_servers: [issuer, "https://other-issuer.example"] },
    { resource, authorization_servers: [issuer], scopes_supported: [] },
  ])("rejects mismatched protected-resource metadata %#", async (value) => {
    const { account, binding } = fixture();
    vi.mocked(oauth.discoverOAuthProtectedResourceMetadata).mockResolvedValue(value);
    await expect(verifyResourceMetadata(account, binding)).rejects.toThrow(/does not match/);
  });

  it.each([
    { ...metadata, issuer: "https://other-issuer.example" },
    { ...metadata, token_endpoint: "https://other-issuer.example/token" },
    { ...metadata, token_endpoint: `${issuer}/token?redirect=other` },
  ])("rejects discovery that changes issuer or token endpoint authority %#", async (value) => {
    vi.mocked(oauth.discoverAuthorizationServerMetadata).mockResolvedValue(value);
    await expect(discoverAccountIssuer(fixture().account)).rejects.toThrow(/could not be verified/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("pins fetch to the issuer origin, rejects redirects and bounds network time", async () => {
    const { account } = fixture();
    const request = credentialFetch(account);
    await expect(request("https://other-issuer.example/token")).rejects.toThrow(/escaped/);
    expect(fetch).not.toHaveBeenCalled();
    vi.mocked(fetch).mockResolvedValue(new Response("{}"));
    await request(`${issuer}/token`, { method: "POST", redirect: "follow" });
    expect(fetch).toHaveBeenCalledWith(`${issuer}/token`, expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
});

describe("standard OAuth device authorization", () => {
  const deviceResponse = { device_code: "synthetic-device-code", user_code: "ABCD-EFGH", verification_uri: `${issuer}/activate`,
    verification_uri_complete: `${issuer}/activate?user_code=ABCD-EFGH`, expires_in: 120, interval: 1 };
  const accessResponse = { access_token: "synthetic-device-access", refresh_token: "synthetic-device-refresh", token_type: "Bearer", expires_in: 3600 };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  function begin(overrides: Partial<typeof deviceResponse> = {}) {
    const store = credentialStore(fixture().secret);
    const onUserCode = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...deviceResponse, ...overrides }), { status: 200 }));
    const options = { ...linkOptions(store), timeoutMs: 120_000, onUserCode };
    return { store, onUserCode, options };
  }

  function outcome(options: Parameters<typeof beginDeviceAccountLink>[0]) {
    return beginDeviceAccountLink(options).then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
  }

  it("acquires a resource-bound public-client credential and persists device provenance", async () => {
    const { store, onUserCode, options } = begin();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(accessResponse), { status: 200 }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toBeUndefined();
    expect(onUserCode).toHaveBeenCalledExactlyOnceWith({ verification_uri: deviceResponse.verification_uri,
      verification_uri_complete: deviceResponse.verification_uri_complete, user_code: deviceResponse.user_code, expires_in: 120 });
    const [deviceUrl, deviceRequest] = vi.mocked(fetch).mock.calls[0]!;
    expect(deviceUrl).toBe(`${issuer}/device`);
    expect(deviceRequest).toMatchObject({ method: "POST", redirect: "error" });
    expect(Object.fromEntries(deviceRequest!.body as URLSearchParams)).toEqual({ client_id: "synthetic-client", resource, scope: "mcp:read" });
    const [tokenUrl, tokenRequest] = vi.mocked(fetch).mock.calls[1]!;
    expect(tokenUrl).toBe(`${issuer}/token`);
    expect(Object.fromEntries(tokenRequest!.body as URLSearchParams)).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "synthetic-client", device_code: "synthetic-device-code", resource });
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.put.mock.calls[0]![1]).toMatchObject({ acquisition: { method: "device_authorization", scopes: ["mcp:read"] },
      tokens: { access_token: "synthetic-device-access" } });
    expect(registry.putUpstreamAccount).toHaveBeenCalledOnce();
    expect(registry.putCredentialBinding).toHaveBeenCalledOnce();
  });

  it.each(["legacy", "helper", "read_only", "existing_client"] as const)("rejects unsupported device setup %s before discovery", async (fault) => {
    const { options } = begin();
    if (fault === "legacy") delete options.account.validation_mode;
    if (fault === "helper") options.account.credential_ref = "helper:synthetic";
    if (fault === "read_only") options.store = { custody: "encrypted_postgres", get: vi.fn() };
    if (fault === "existing_client") options.account.client_id = "synthetic-pre-registered-client";
    await expect(beginDeviceAccountLink(options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(oauth.discoverAuthorizationServerMetadata).not.toHaveBeenCalled();
    expect(oauth.registerClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["foreign_endpoint", "missing_endpoint", "unsupported_grant"] as const)("rejects issuer device metadata %s", async (fault) => {
    const { options } = begin();
    const changed: Omit<typeof metadata, "device_authorization_endpoint"> & { device_authorization_endpoint?: string } = { ...metadata };
    if (fault === "foreign_endpoint") changed.device_authorization_endpoint = "https://other-issuer.example/device";
    if (fault === "missing_endpoint") delete changed.device_authorization_endpoint;
    if (fault === "unsupported_grant") changed.grant_types_supported = ["authorization_code"];
    vi.mocked(oauth.discoverAuthorizationServerMetadata).mockResolvedValue(changed);
    await expect(beginDeviceAccountLink(options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(oauth.registerClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { verification_uri: "https://other-issuer.example/activate" },
    { verification_uri_complete: "https://other-issuer.example/activate?user_code=ABCD-EFGH" },
    { verification_uri_complete: "https://synthetic-user:synthetic-password@issuer.example/activate?user_code=ABCD-EFGH" },
    { verification_uri_complete: `${issuer}/activate?user_code=ABCD-EFGH#fragment` },
  ])("never displays an unpinned verification URL %#", async (overrides) => {
    const { options, onUserCode, store } = begin(overrides);
    await expect(beginDeviceAccountLink(options)).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(onUserCode).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.put).not.toHaveBeenCalled();
  });

  it.each([
    `${issuer}/other?user_code=ABCD-EFGH`, `${issuer}/activate?code=issuer-specific-code`,
    `${issuer}/activate?user_code=ABCD-EFGH&session=issuer-specific-session`,
  ])("accepts issuer-defined complete verification paths and queries: %s", async (verification_uri_complete) => {
    const { options, onUserCode } = begin({ verification_uri_complete });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(accessResponse), { status: 200 }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toBeUndefined();
    expect(onUserCode).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ verification_uri_complete }));
  });

  it("rejects a foreign token endpoint before registration or a device request", async () => {
    const { options, onUserCode, store } = begin();
    vi.mocked(oauth.discoverAuthorizationServerMetadata).mockResolvedValue({ ...metadata, token_endpoint: "https://other-issuer.example/token" });
    await expect(beginDeviceAccountLink(options)).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(oauth.registerClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(onUserCode).not.toHaveBeenCalled();
    expect(store.put).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "mcp:read mcp:write"])("rejects an explicit empty or expanded device token scope %j", async (scope) => {
    const { options, store } = begin();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ...accessResponse, scope }), { status: 200 }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toMatchObject({ shape: { code: "forbidden" } });
    expect(store.put).not.toHaveBeenCalled();
    expect(registry.putUpstreamAccount).not.toHaveBeenCalled();
    expect(readUpstreamCatalog).not.toHaveBeenCalled();
  });

  it("accepts an omitted device token scope using exact acquisition provenance", async () => {
    const { options, store } = begin();
    expect(accessResponse).not.toHaveProperty("scope");
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(accessResponse), { status: 200 }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toBeUndefined();
    const saved = OAuthCredential.parse(store.put.mock.calls[0]![1]);
    expect(saved.tokens.scope).toBeUndefined();
    expect(saved.acquisition!.scopes).toEqual(["mcp:read"]);
  });

  it("bounds an unfinished user-code display callback by the device expiry", async () => {
    const { options, store } = begin({ expires_in: 2 });
    options.onUserCode = vi.fn(() => new Promise<void>(() => undefined));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await result).error).toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("handles authorization_pending and increases every later interval after slow_down", async () => {
    const { options, store } = begin();
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "slow_down" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(accessResponse), { status: 200 }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetch).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).error).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(store.put).toHaveBeenCalledOnce();
  });

  it.each([
    [400, "access_denied"], [400, "expired_token"], [400, "invalid_grant"],
    [401, "authorization_pending"], [429, "slow_down"], [500, "server_error"],
  ])("stops polling on terminal or non-RFC error %s/%s", async (status, error) => {
    const { options, store } = begin();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error }), { status: Number(status) }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toMatchObject({ shape: { code: "operation_unavailable" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.put).not.toHaveBeenCalled();
    expect(registry.putUpstreamAccount).not.toHaveBeenCalled();
  });

  it("does not poll at or after the device code's expiry", async () => {
    const { options, store } = begin({ expires_in: 1 });
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("rejects a token response received after expiry even when HTTP succeeded", async () => {
    const { options, store } = begin({ expires_in: 2 });
    vi.mocked(fetch).mockImplementationOnce(async () => {
      vi.setSystemTime(NOW + 2001);
      return new Response(JSON.stringify(accessResponse), { status: 200 });
    });
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(store.put).not.toHaveBeenCalled();
    expect(registry.putUpstreamAccount).not.toHaveBeenCalled();
  });

  it("honors the caller's shorter overall deadline", async () => {
    const { options, store } = begin({ expires_in: 120 });
    options.timeoutMs = 500;
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).error).toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(store.put).not.toHaveBeenCalled();
  });

  it("never retries a successful exchange after uncertain credential persistence", async () => {
    const { options, store } = begin();
    store.put.mockRejectedValue(new Error("Synthetic ambiguous persistence result"));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(accessResponse), { status: 200 }));
    const result = outcome(options);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).error).toMatchObject({ shape: { code: "operation_unavailable" } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledOnce();
    expect(registry.putUpstreamAccount).not.toHaveBeenCalled();
  });
});
