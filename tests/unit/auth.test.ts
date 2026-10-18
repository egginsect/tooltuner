import type { Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newId, SCHEMA_VERSION, type Grant, type Principal } from "../../src/contracts.js";
import type { GraphClient } from "../../src/db/client.js";
import { StorageError } from "../../src/errors.js";
import * as store from "../../src/db/auth.js";
import { FlywheelOAuthProvider } from "../../src/gateway/oauth/provider.js";
import { renderConsentPage } from "../../src/gateway/oauth/consent.js";
import { COMMANDS } from "../../src/cli/owner.js";

const db = {} as GraphClient;
const grant: Grant = { schema_version: SCHEMA_VERSION, grant_id: newId("grant"), owner_id: "owner", label: "approved",
  groups: ["user"], allow: { apps: ["textkit"], tools: {}, repos: [] }, scope: {}, created_at: new Date().toISOString(), revoked_at: null };
const client = { client_id: "public-client", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none" as const };
const principal: Principal = { owner_id: "owner", subject: "owner:owner", client_id: client.client_id, grant_id: grant.grant_id, session_id: "session" };
const options = { db, ownerId: "owner", resource: "https://gateway.example/mcp", ownerSecret: "test-owner-consent-secret" };
const outage = new StorageError("storage_unavailable", "test storage failure");
afterEach(() => vi.restoreAllMocks());

async function pending(provider: FlywheelOAuthProvider) {
  let html = "";
  const res = { status: () => res, set: () => res, send: (value: string) => { html = value; return res; } };
  vi.spyOn(store, "listGrants").mockResolvedValue([grant]);
  await provider.authorize(client, { redirectUri: client.redirect_uris[0]!, codeChallenge: "a".repeat(43), scopes: ["flywheel"] }, res as unknown as Response);
  const id = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
  if (!id) throw new Error("Missing pending consent request");
  return id;
}

async function login(provider: FlywheelOAuthProvider, id: string): Promise<string> {
  const result = await provider.authenticateOwner({ requestId: id, ownerSecret: options.ownerSecret });
  if (!("html" in result)) throw new Error("Owner login failed");
  const token = /name="selection_token" value="([^"]+)"/.exec(result.html)?.[1];
  if (!token) throw new Error("Missing selection capability");
  expect(result.html).not.toContain(options.ownerSecret);
  return token;
}

describe("OAuth trust boundaries", () => {
  it("cannot approve consent without a configured owner secret", async () => {
    const provider = new FlywheelOAuthProvider({ ...options, ownerSecret: undefined });
    const id = await pending(provider);
    const lookup = vi.spyOn(store, "getGrant");
    const result = await provider.authenticateOwner({ requestId: id, ownerSecret: "" });
    expect(result).toMatchObject({ status: 403 });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not query grants before successful owner authentication", async () => {
    const provider = new FlywheelOAuthProvider(options);
    const id = await pending(provider);
    expect(store.listGrants).not.toHaveBeenCalled();
    const read = vi.spyOn(store, "getGrant");
    expect(await provider.completeConsent({ requestId: id, grantId: grant.grant_id, approve: true })).toMatchObject({ status: 403 });
    expect(await provider.authenticateOwner({ requestId: id, ownerSecret: "incorrect" })).toMatchObject({ status: 403 });
    expect(store.listGrants).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    await login(provider, id);
    expect(store.listGrants).toHaveBeenCalledOnce();
  });

  it("binds selection capabilities to one request, consumes them once, and expires them", async () => {
    let now = Date.now();
    const provider = new FlywheelOAuthProvider({ ...options, now: () => now });
    const first = await pending(provider);
    const second = await pending(provider);
    const token = await login(provider, first);
    const otherToken = await login(provider, second);
    const read = vi.spyOn(store, "getGrant").mockResolvedValue(grant);
    vi.spyOn(store, "insertCode").mockResolvedValue();
    expect(await provider.completeConsent({ requestId: second, selectionToken: token, grantId: grant.grant_id, approve: true })).toMatchObject({ status: 403 });
    expect(read).not.toHaveBeenCalled();
    expect(await provider.authenticateOwner({ requestId: first, ownerSecret: options.ownerSecret })).toMatchObject({ status: 400 });
    const input = { requestId: first, selectionToken: token, grantId: grant.grant_id, approve: true };
    expect(await provider.completeConsent(input)).toHaveProperty("redirectTo");
    expect(await provider.completeConsent(input)).toMatchObject({ status: 400 });
    now += 5 * 60_000;
    expect(await provider.completeConsent({ requestId: second, selectionToken: otherToken, grantId: grant.grant_id, approve: true })).toMatchObject({ status: 403 });
    expect(read).toHaveBeenCalledOnce();
  });

  it("fails closed if grant lookup fails after owner authentication", async () => {
    const provider = new FlywheelOAuthProvider(options);
    const id = await pending(provider);
    vi.mocked(store.listGrants).mockRejectedValue(outage);
    await expect(provider.authenticateOwner({ requestId: id, ownerSecret: options.ownerSecret })).rejects.toBe(outage);
    expect(await provider.completeConsent({ requestId: id, grantId: grant.grant_id, approve: true })).toMatchObject({ status: 400 });
  });

  it("rejects unsafe requested redirects at the provider boundary before reading grants", async () => {
    const provider = new FlywheelOAuthProvider(options);
    const list = vi.spyOn(store, "listGrants");
    for (const uri of ["http://userinfo:password@localhost:9/callback", "http://@localhost:9/callback",
      "http://localhost:9/callback#fragment", "http://localhost:9/callback#", "ftp://localhost:9/callback",
      "http://localhost:9/other", "http://127.0.0.1:9/callback", "http://localhost:9/callback?extra=1"]) {
      let status = 0;
      const res = { status: (value: number) => { status = value; return res; }, set: () => res, type: () => res, send: () => res };
      await provider.authorize({ ...client, redirect_uris: ["http://localhost:9/callback"] },
        { redirectUri: uri, codeChallenge: "a".repeat(43), scopes: ["flywheel"] }, res as unknown as Response);
      expect(status).toBe(400);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("rejects cross-owner principal/grant combinations", async () => {
    const provider = new FlywheelOAuthProvider(options);
    vi.spyOn(store, "getGrant").mockResolvedValue({ ...grant, owner_id: "other-owner" });
    await expect(provider.loadGrant(principal)).rejects.toThrow(/revoked/);
    await expect(provider.loadGrant({ ...principal, owner_id: "other-owner" })).rejects.toThrow(/owner/);
  });

  it("does not acknowledge consent when durable code storage fails", async () => {
    const provider = new FlywheelOAuthProvider(options);
    const id = await pending(provider);
    vi.spyOn(store, "getGrant").mockResolvedValue(grant);
    vi.spyOn(store, "insertCode").mockRejectedValue(outage);
    const input = { requestId: id, grantId: grant.grant_id, selectionToken: await login(provider, id), approve: true };
    await expect(provider.completeConsent(input)).rejects.toBe(outage);
    expect(await provider.completeConsent(input)).toMatchObject({ status: 400 });
  });

  it("propagates storage failures from access verification and grant reload", async () => {
    const provider = new FlywheelOAuthProvider(options);
    vi.spyOn(store, "getToken").mockRejectedValue(outage);
    vi.spyOn(store, "getGrant").mockRejectedValue(outage);
    await expect(provider.verifyAccessToken("opaque-token")).rejects.toBe(outage);
    await expect(provider.loadGrant(principal)).rejects.toBe(outage);
  });

  it("does not acknowledge failed token-pair persistence", async () => {
    const provider = new FlywheelOAuthProvider(options);
    vi.spyOn(store, "consumeCode").mockResolvedValue({ client_id: client.client_id, grant_id: grant.grant_id, family_id: "family",
      redirect_uri: client.redirect_uris[0]!, code_challenge: "a".repeat(43), resource: options.resource, scopes: ["flywheel"], expires_at: 9999999999 });
    vi.spyOn(store, "issueTokenPair").mockRejectedValue(outage);
    await expect(provider.exchangeAuthorizationCode(client, "opaque-code", undefined, client.redirect_uris[0])).rejects.toBe(outage);
  });

  it("rejects tokens bound to another resource or owner before producing a principal", async () => {
    const provider = new FlywheelOAuthProvider(options);
    const token = { client_id: client.client_id, grant_id: grant.grant_id, family_id: "family", kind: "access" as const,
      resource: "https://other.example/mcp", scopes: ["flywheel"], expires_at: 9999999999, revoked: false };
    const lookup = vi.spyOn(store, "getToken").mockResolvedValue(token);
    vi.spyOn(store, "getGrant").mockResolvedValue({ ...grant, owner_id: "other-owner" });
    await expect(provider.verifyAccessToken("opaque-token")).rejects.toThrow(/resource/);
    lookup.mockResolvedValue({ ...token, resource: options.resource });
    await expect(provider.verifyAccessToken("opaque-token")).rejects.toThrow(/revoked/);
  });

  it("renders untrusted client and grant labels as escaped text", () => {
    const html = renderConsentPage({ requestId: '"<script>', client: { ...client, client_name: "<script>alert(1)</script>" }, resource: options.resource,
      grants: [{ ...grant, label: '<img src=x onerror="alert(1)">' }], selectionToken: "one-time-token", redirectUri: client.redirect_uris[0]! });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(options.ownerSecret);
  });
});

describe("owner grant commands", () => {
  it("creates explicit union grants with app/tool/repo/packet restrictions", async () => {
    const insert = vi.spyOn(store, "insertGrant").mockResolvedValue();
    const packet = newId("packet");
    const result = await COMMANDS["grant create"]!(db, "owner", ["--label", "reviewer", "--groups", "development,management", "--apps", "textkit,flywheel",
      "--tools", "textkit:echo+count", "--repos", "repo-one", "--packet", packet]);
    expect(result).toMatchObject({ owner_id: "owner", groups: ["development", "management"],
      allow: { apps: ["textkit", "flywheel"], tools: { textkit: ["echo", "count"] }, repos: ["repo-one"] }, scope: { packet_id: packet } });
    expect(insert).toHaveBeenCalledOnce();
    expect(Object.keys(COMMANDS)).not.toContain("merge");
  });

  it("rejects malformed tool restrictions instead of silently broadening them", async () => {
    const insert = vi.spyOn(store, "insertGrant");
    await expect(COMMANDS["grant create"]!(db, "owner", ["--label", "user", "--groups", "user", "--apps", "textkit", "--tools", "textkit:echo:ignored"])).rejects.toThrow(/must look like/);
    expect(insert).not.toHaveBeenCalled();
  });
});
