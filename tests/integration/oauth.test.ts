import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { newId, SCHEMA_VERSION, type Grant, type Principal } from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema, INDEX_SPECS } from "../../src/db/schema.js";
import { getGrant, hashSecret, insertGrant, revokeGrant } from "../../src/db/auth.js";
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, FlywheelOAuthProvider } from "../../src/gateway/oauth/provider.js";
import { mountGateway, type GatewayCore } from "../../src/gateway/mcp.js";
import { COMMANDS } from "../../src/cli/owner.js";

const OWNER_SECRET = "test-owner-secret-0123456789";
const REDIRECT = "http://localhost:9/callback";
// Only this invocation owns this graph; never drop a fixed/shared graph.
const graph = `oauth_${randomUUID().replaceAll("-", "")}`;
let db: GraphClient;
let server: Server;
let origin: string;
let grant: Grant;
let foreignGrant: Grant;
let clientId: string;
let otherClientId: string;
let clockOffset = 0;
let lastPrincipal: Principal | undefined;
let coreCalls = 0;

interface Tokens { access_token: string; refresh_token: string }
const fakeCore: GatewayCore = {
  async listApps(ctx) {
    coreCalls++;
    lastPrincipal = ctx.principal;
    return { apps: [{ application: "flywheel", stable_version: null, description: `grant ${ctx.grant.grant_id}` }],
      completeness: { status: "complete", missing_refs: [], notes: [] } };
  },
  async describe() { coreCalls++; throw new Error("unused"); },
  async dispatch() { coreCalls++; throw new Error("unused"); },
};
const form = (body: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(), redirect: "manual" as const });
const tokenRequest = (body: Record<string, string>) => fetch(`${origin}/token`, form({ client_id: clientId, ...body }));
const refreshRequest = (token: string, extra: Record<string, string> = {}) => tokenRequest({ grant_type: "refresh_token", refresh_token: token, ...extra });
const bearerRequest = (token: string) => fetch(`${origin}/mcp`, { method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

async function pending(extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(`${origin}/authorize`);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    state: "st-1", resource: `${origin}/mcp`, ...extra })) url.searchParams.set(k, v);
  const response = await fetch(url, { redirect: "manual" });
  return { response, verifier, page: response.status === 200 ? await response.text() : "" };
}
const requestId = (page: string) => {
  const id = /name="request_id" value="([^"]+)"/.exec(page)?.[1];
  if (!id) throw new Error("Consent page did not contain a request id");
  return id;
};
const ownerLogin = (id: string, secret = OWNER_SECRET) => fetch(`${origin}/oauth/owner-login`, form({ request_id: id, owner_secret: secret }));
const selectionToken = (page: string) => {
  const token = /name="selection_token" value="([^"]+)"/.exec(page)?.[1];
  if (!token) throw new Error("Selection page did not contain a capability");
  return token;
};
async function login(id: string): Promise<string> {
  const response = await ownerLogin(id);
  expect(response.status).toBe(200);
  const page = await response.text();
  expect(page).not.toContain(OWNER_SECRET);
  expect(page).not.toContain('name="owner_secret"');
  return selectionToken(page);
}
const consent = (id: string, extra: Record<string, string> = {}) => fetch(`${origin}/oauth/consent`,
  form({ request_id: id, grant_id: grant.grant_id, decision: "approve", ...extra }));
async function authorizationCode() {
  const { response, page, verifier } = await pending();
  expect(response.status).toBe(200);
  const id = requestId(page);
  const approved = await consent(id, { selection_token: await login(id) });
  expect(approved.status).toBe(302);
  const location = new URL(approved.headers.get("location")!);
  expect(location.searchParams.get("state")).toBe("st-1");
  return { grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier,
    redirect_uri: REDIRECT, resource: `${origin}/mcp` };
}
async function session(): Promise<Tokens> {
  const response = await tokenRequest(await authorizationCode());
  expect(response.status).toBe(200);
  return await response.json() as Tokens;
}
async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

beforeAll(async () => {
  db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph });
  await bootstrapSchema(db, INDEX_SPECS);
});
beforeEach(async () => {
  clockOffset = 0;
  grant = { schema_version: SCHEMA_VERSION, grant_id: newId("grant"), owner_id: "owner", label: "test user grant", groups: ["user"],
    allow: { apps: ["textkit"], tools: {}, repos: ["test-private-repo"] }, scope: { job_id: newId("job"), packet_id: newId("packet") }, created_at: new Date().toISOString(), revoked_at: null };
  foreignGrant = { ...grant, grant_id: newId("grant"), owner_id: "other-owner", label: "foreign-owner-private-label" };
  await insertGrant(db, grant);
  await insertGrant(db, foreignGrant);
  const app = express();
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = new FlywheelOAuthProvider({ db, ownerId: "owner", resource: `${origin}/mcp`, ownerSecret: OWNER_SECRET,
    now: () => Date.now() + clockOffset });
  mountGateway(app, { provider, core: fakeCore, publicOrigin: origin, resource: `${origin}/mcp` });
  async function register() {
    const response = await fetch(`${origin}/register`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", client_name: "Test <Client>" }) });
    expect(response.status).toBe(201);
    const result = await response.json() as { client_id: string; client_secret?: string };
    expect(result.client_secret).toBeUndefined();
    return result.client_id;
  }
  clientId = await register();
  otherClientId = await register();
});
afterEach(async () => {
  if (server?.listening) await new Promise<void>((r) => server.close(() => r()));
});
afterAll(async () => {
  if (db) { try { await db.dropGraph(); } finally { await db.close(); } }
});

describe("real OAuth authorization server and protected MCP", () => {
  it("publishes metadata and a bearer discovery challenge", async () => {
    const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json() as Record<string, unknown>;
    expect(as.issuer).toBe(`${origin}/`);
    expect(as.registration_endpoint).toBe(`${origin}/register`);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.revocation_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    const pr = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json() as Record<string, unknown>;
    expect(pr.resource).toBe(`${origin}/mcp`);
    expect(pr.authorization_servers).toEqual([`${origin}/`]);
    const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("rejects unsafe/confidential DCR rather than storing client secrets", async () => {
    for (const metadata of [
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" },
      { redirect_uris: ["https://client.example/callback#fragment"], token_endpoint_auth_method: "none" },
      { redirect_uris: ["http://client.example/callback"], token_endpoint_auth_method: "none" },
    ]) {
      const response = await fetch(`${origin}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(metadata) });
      expect(response.status).toBe(400);
    }
    const rows = await db.roQuery<{ doc: string }>("MATCH (c:OAuthClient) RETURN c.doc AS doc");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => !r.doc.includes("client_secret"))).toBe(true);
  });

  it("uses safe redirect error paths for bad resource, scope, redirect and PKCE", async () => {
    for (const [extra, error] of [
      [{ resource: "https://other.example/mcp" }, "invalid_target"],
      [{ scope: "management" }, "invalid_scope"],
      [{ code_challenge_method: "plain" }, "invalid_request"],
    ] as const) {
      const { response } = await pending(extra);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get("error")).toBe(error);
    }
    const { response } = await pending({ redirect_uri: "https://attacker.example/steal" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps consent denial and malformed forms separate, escapes HTML and isolates owners", async () => {
    const { page, response } = await pending();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(page).toContain("Test &lt;Client&gt;");
    for (const value of [grant.grant_id, grant.label, "textkit", "test-private-repo", grant.scope.job_id!, grant.scope.packet_id!, foreignGrant.label]) {
      expect(page.includes(value)).toBe(false);
    }
    expect(page).not.toContain('name="selection_token"');
    const id = requestId(page);
    expect((await consent(id, { decision: "bogus" })).status).toBe(400);
    expect((await ownerLogin(id, "incorrect")).status).toBe(403);
    expect((await consent(id, { owner_secret: OWNER_SECRET })).status).toBe(403);
    const denied = await consent(id, { decision: "deny", owner_secret: "" });
    const location = new URL(denied.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("st-1");
    expect(location.searchParams.has("code")).toBe(false);
    expect((await consent(id)).status).toBe(400);
    const another = await pending();
    const anotherId = requestId(another.page);
    expect((await consent(anotherId, { grant_id: foreignGrant.grant_id, selection_token: await login(anotherId) })).status).toBe(400);
  });

  it("allows only one concurrent consent approval", async () => {
    const { page } = await pending();
    const id = requestId(page);
    const token = await login(id);
    const results = await Promise.all([consent(id, { selection_token: token }), consent(id, { selection_token: token })]);
    expect(results.map((r) => r.status).sort()).toEqual([302, 400]);
  });

  it("requires a matching one-time selection capability and never reuses the owner secret in approval", async () => {
    const first = requestId((await pending()).page);
    const second = requestId((await pending()).page);
    const token = await login(first);
    const other = await login(second);
    expect((await consent(first)).status).toBe(403);
    expect((await consent(first, { selection_token: "forged" })).status).toBe(403);
    expect((await consent(second, { selection_token: token })).status).toBe(403);
    expect((await ownerLogin(first)).status).toBe(400);
    const approved = await consent(first, { selection_token: token });
    expect(approved.status).toBe(302);
    const location = approved.headers.get("location")!;
    expect(location).not.toContain(token);
    expect(location).not.toContain(OWNER_SECRET);
    expect((await consent(first, { selection_token: token })).status).toBe(400);
    try {
      clockOffset = 5 * 60_000;
      expect((await consent(second, { selection_token: other })).status).toBe(403);
    } finally { clockOffset = 0; }
  });

  it("rejects unsafe requested callbacks before all SDK redirects and allows only loopback port relaxation", async () => {
    for (const uri of ["http://userinfo:password@localhost:9/callback", "http://@localhost:9/callback",
      `${REDIRECT}#fragment`, `${REDIRECT}#`, "ftp://localhost:9/callback"]) {
      for (const method of ["S256", "plain"]) {
        const result = await pending({ redirect_uri: uri, code_challenge_method: method });
        expect(result.response.status).toBe(400);
        expect(result.response.headers.get("location")).toBeNull();
      }
      const posted = await fetch(`${origin}/authorize`, form({ redirect_uri: uri, client_id: clientId, response_type: "code" }));
      expect(posted.status).toBe(400);
      expect(posted.headers.get("location")).toBeNull();
    }
    for (const uri of ["http://127.0.0.1:9/callback", "http://localhost:9/other", "http://localhost:9/callback?extra=1"]) {
      expect((await pending({ redirect_uri: uri })).response.status).toBe(400);
    }
    const actual = "http://localhost:12345/callback";
    const { page, verifier, response } = await pending({ redirect_uri: actual });
    expect(response.status).toBe(200);
    const id = requestId(page);
    const authenticated = await ownerLogin(id);
    const selectionPage = await authenticated.text();
    expect(authenticated.status).toBe(200);
    expect(selectionPage).toContain(`<code>${actual}</code>`);
    expect(selectionPage).not.toContain(`<code>${REDIRECT}</code>`);
    const approved = await consent(id, { selection_token: selectionToken(selectionPage) });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(actual);
    const token = await tokenRequest({ grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, redirect_uri: actual });
    expect(token.status).toBe(200);
  });

  it("requires the correct client, PKCE verifier and redirect for code exchange", async () => {
    const code = await authorizationCode();
    expect((await tokenRequest({ ...code, client_id: otherClientId })).status).toBe(400);
    expect((await tokenRequest({ ...code, code_verifier: randomBytes(32).toString("base64url") })).status).toBe(400);
    const ok = await tokenRequest(code);
    expect(ok.status).toBe(200);
    const tokens = await ok.json() as Tokens;
    expect((await bearerRequest(tokens.access_token)).status).toBe(200);
    const wrongRedirect = await authorizationCode();
    expect((await tokenRequest({ ...wrongRedirect, redirect_uri: "https://attacker.example/cb" })).status).toBe(400);
    const omittedRedirect = await authorizationCode();
    delete (omittedRedirect as Partial<typeof omittedRedirect>).redirect_uri;
    expect((await tokenRequest(omittedRedirect)).status).toBe(400);
    const wrongResource = await authorizationCode();
    expect((await tokenRequest({ ...wrongResource, resource: "https://other.example/mcp" })).status).toBe(400);
  });

  it("revokes the code's session on authorization-code replay", async () => {
    const code = await authorizationCode();
    const ok = await tokenRequest(code);
    expect(ok.status).toBe(200);
    const tokens = await ok.json() as Tokens;
    expect((await tokenRequest(code)).status).toBe(400);
    expect((await bearerRequest(tokens.access_token)).status).toBe(401);
    expect((await refreshRequest(tokens.refresh_token)).status).toBe(400);
  });

  it("exposes exactly three tools, binds the principal and rejects identity injection", async () => {
    const tokens = await session();
    const client = await mcpClient(tokens.access_token);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["describe", "dispatch", "list_apps"]);
      expect(tools.find((t) => t.name === "dispatch")!.annotations?.readOnlyHint).toBe(false);
      const result = await client.callTool({ name: "list_apps", arguments: {} });
      expect(JSON.stringify(result.structuredContent)).toContain(grant.grant_id);
      expect(lastPrincipal).toMatchObject({ owner_id: "owner", client_id: clientId, grant_id: grant.grant_id });
      const before = coreCalls;
      const injection = await client.callTool({ name: "dispatch", arguments: { application: "textkit", tool: "echo", owner_id: "other-owner" } });
      expect(injection.isError).toBe(true);
      expect(coreCalls).toBe(before);
    } finally { await client.close(); }
    expect((await fetch(`${origin}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(405);
  });

  it("stores only credential hashes and never the owner consent secret", async () => {
    const code = await authorizationCode();
    const response = await tokenRequest(code);
    expect(response.status).toBe(200);
    const tokens = await response.json() as Tokens;
    const rows = await db.roQuery<{ hash: string }>("MATCH (t:OAuthToken) RETURN t.token_hash AS hash");
    expect(rows.some((r) => r.hash === hashSecret(tokens.access_token))).toBe(true);
    const docs = await db.roQuery<{ doc: string }>("MATCH (n) WHERE n.doc IS NOT NULL RETURN n.doc AS doc");
    const serialized = JSON.stringify(docs);
    for (const secret of [tokens.access_token, tokens.refresh_token, code.code, OWNER_SECRET]) expect(serialized.includes(secret)).toBe(false);
  });

  it("prevents refresh scope/resource widening and another client's refresh/revoke", async () => {
    const tokens = await session();
    for (const extra of [{ scope: "management" }, { resource: "https://other.example/mcp" }, { client_id: otherClientId }] as Record<string, string>[]) {
      expect((await refreshRequest(tokens.refresh_token, extra)).status).toBe(400);
    }
    const revoke = await fetch(`${origin}/revoke`, form({ client_id: otherClientId, token: tokens.refresh_token }));
    expect(revoke.status).toBe(200);
    expect((await bearerRequest(tokens.access_token)).status).toBe(200);
    const rotated = await refreshRequest(tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as Tokens;
    expect((await refreshRequest(tokens.refresh_token)).status).toBe(400);
    expect((await bearerRequest(next.access_token)).status).toBe(401);
    expect((await refreshRequest(next.refresh_token)).status).toBe(400);
  });

  it("revokes even replacements minted concurrently with refresh replay", async () => {
    const tokens = await session();
    const results = await Promise.all([refreshRequest(tokens.refresh_token), refreshRequest(tokens.refresh_token)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const next = await results.find((r) => r.status === 200)!.json() as Tokens;
    expect((await bearerRequest(next.access_token)).status).toBe(401);
    expect((await refreshRequest(next.refresh_token)).status).toBe(400);
  });

  it("implements client-bound token revocation", async () => {
    const tokens = await session();
    expect((await fetch(`${origin}/revoke`, form({ client_id: clientId, token: tokens.access_token }))).status).toBe(200);
    expect((await bearerRequest(tokens.access_token)).status).toBe(401);
    expect((await refreshRequest(tokens.refresh_token)).status).toBe(400);
    expect((await fetch(`${origin}/revoke`, form({ client_id: clientId, token: "unknown" }))).status).toBe(200);
  });

  it("expires access, refresh, codes and pending consent", async () => {
    const tokens = await session();
    const code = await authorizationCode();
    const { page } = await pending();
    try {
      clockOffset = (REFRESH_TTL_SEC + ACCESS_TTL_SEC) * 1000;
      expect((await bearerRequest(tokens.access_token)).status).toBe(401);
      expect((await refreshRequest(tokens.refresh_token)).status).toBe(400);
      expect((await tokenRequest(code)).status).toBe(400);
      expect((await consent(requestId(page))).status).toBe(400);
    } finally { clockOffset = 0; }
  });

  it("keeps owner CLI revocation within its tenant and blocks live sessions and codes after revoke", async () => {
    const tokens = await session();
    const code = await authorizationCode();
    await expect(COMMANDS["grant revoke"]!(db, "owner", [foreignGrant.grant_id])).rejects.toThrow(/not found/);
    expect((await getGrant(db, foreignGrant.grant_id))?.revoked_at).toBeNull();
    await revokeGrant(db, grant.grant_id, new Date().toISOString(), "owner");
    expect((await bearerRequest(tokens.access_token)).status).toBe(401);
    expect((await refreshRequest(tokens.refresh_token)).status).toBe(400);
    expect((await tokenRequest(code)).status).toBe(400);
  });

  it("fails closed during a database failure without leaking credentials or invoking the core", async () => {
    // End of suite: close only this client's connection, leaving the real DB running.
    const tokens = await session();
    await db.close();
    const before = coreCalls;
    const response = await bearerRequest(tokens.access_token);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain(OWNER_SECRET);
    expect(body).not.toContain(tokens.access_token);
    expect(coreCalls).toBe(before);
    // Reconnect solely to clean up this invocation's throwaway graph.
    db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph });
  });
});
