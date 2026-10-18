/** A real local SDK OAuth server and two protected MCP deployments for repeatable credential tests. */
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError, InvalidScopeError, InvalidTargetError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthCredential } from "../src/gateway/credentials.js";

interface StoredToken { client: string; resource: string; scopes: string[]; expires: number }
export interface ProtectedFixtureFaults {
  publicRuntime?: boolean; ignoreAudience?: boolean; wrongMetadata?: boolean; redirectRuntime?: boolean;
  omitResourceScopes?: boolean; disableIntrospection?: boolean; wrongIntrospectionAudience?: boolean; missingScope?: boolean; changedSchema?: boolean;
}

export async function startProtectedFixture() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Protected fixture did not receive a loopback port.");
  const origin = `http://127.0.0.1:${address.port}`;
  const issuer = `${origin}/`;
  const clients = new Map<string, OAuthClientInformationFull>();
  const pending = new Map<string, { client: OAuthClientInformationFull; params: AuthorizationParams }>();
  const codes = new Map<string, { client: string; params: AuthorizationParams }>();
  const access = new Map<string, StoredToken>();
  const refresh = new Map<string, StoredToken>();
  const ownerConsent = randomBytes(24).toString("base64url");
  const scopes = ["fixture:read"];
  const faults: ProtectedFixtureFaults = {};
  const metrics = { registrations: 0, refreshes: 0, consent: 0, initialized: 0, toolCalls: 0, denied: 0, rejectedAudience: 0 };
  const live = new Set<McpServer>();
  const opaque = () => randomBytes(32).toString("base64url");
  function issue(client: string, resource: string, grantedScopes = scopes): OAuthTokens {
    if (new URL(resource).origin !== origin) throw new InvalidTargetError("Fixture resources must stay on the local issuer origin.");
    const token = opaque(), renewal = opaque();
    const value = { client, resource, scopes: grantedScopes, expires: Math.floor(Date.now() / 1000) + 3600 };
    access.set(token, value); refresh.set(renewal, value);
    return { access_token: token, refresh_token: renewal, token_type: "Bearer", expires_in: 3600, scope: grantedScopes.join(" "), issuer };
  }
  const provider: OAuthServerProvider = {
    clientsStore: {
      getClient(clientId) { return clients.get(clientId); },
      registerClient(value) { const client = { ...value, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) }; clients.set(client.client_id, client); metrics.registrations++; return client; },
    },
    async authorize(client, params, response) {
      if (!params.resource || params.resource.origin !== origin) throw new InvalidTargetError("Explicit local resource required.");
      if ((params.scopes ?? []).some((scope) => !scopes.includes(scope))) throw new InvalidScopeError("Unsupported fixture scope.");
      const requestId = opaque(); pending.set(requestId, { client, params });
      response.set("cache-control", "no-store").type("html").send(`<form method="post" action="/consent"><input name="request_id" value="${requestId}" readonly><input name="owner_secret" type="password"><button name="decision" value="approve">Approve local fixture account</button></form>`);
    },
    async challengeForAuthorizationCode(client, code) { const value = codes.get(code); if (!value || value.client !== client.client_id) throw new InvalidGrantError("Invalid fixture code."); return value.params.codeChallenge; },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      const value = codes.get(code); codes.delete(code);
      if (!value || !resource || value.client !== client.client_id || redirectUri !== value.params.redirectUri || resource.href !== value.params.resource?.href) throw new InvalidGrantError("Fixture authorization code binding mismatch.");
      return issue(client.client_id, resource.href, value.params.scopes);
    },
    async exchangeRefreshToken(client, token, requestedScopes, resource) {
      const value = refresh.get(token); refresh.delete(token);
      if (!value || value.client !== client.client_id || !resource || requestedScopes?.some((scope) => !value.scopes.includes(scope))) throw new InvalidGrantError("Fixture refresh binding mismatch.");
      metrics.refreshes++;
      return issue(client.client_id, resource.href, requestedScopes ?? value.scopes);
    },
    async verifyAccessToken(token) {
      const value = access.get(token);
      if (!value || value.expires <= Date.now() / 1000) { metrics.denied++; throw new InvalidTokenError("Invalid fixture token."); }
      return { token, clientId: value.client, scopes: faults.missingScope ? [] : value.scopes, expiresAt: value.expires, resource: new URL(value.resource) };
    },
  };
  app.post("/consent", (request, response) => {
    const value = pending.get(String(request.body?.request_id));
    if (!value || request.body?.owner_secret !== ownerConsent || request.body?.decision !== "approve") { response.status(403).end(); return; }
    pending.delete(String(request.body.request_id));
    const code = opaque(); codes.set(code, { client: value.client.client_id, params: value.params });
    const callback = new URL(value.params.redirectUri); callback.searchParams.set("code", code); if (value.params.state) callback.searchParams.set("state", value.params.state);
    metrics.consent++; response.redirect(302, callback.href);
  });
  for (const deployment of ["deployment-a", "deployment-b"]) {
    app.get(`/.well-known/oauth-protected-resource/${deployment}/mcp`, (_request, response) => response.json({
      resource: faults.wrongMetadata ? `${origin}/wrong-resource/mcp` : `${origin}/${deployment}/mcp`, authorization_servers: [issuer], ...(faults.omitResourceScopes ? {} : { scopes_supported: scopes }),
    }));
  }
  app.post("/introspect", (request, response) => {
    if (faults.disableIntrospection) { response.status(404).end(); return; }
    const value = access.get(String(request.body?.token));
    if (!value || request.body?.client_id !== value.client) { response.json({ active: false }); return; }
    response.json({ active: value.expires > Date.now() / 1000, aud: faults.wrongIntrospectionAudience ? `${origin}/wrong-audience` : value.resource,
      client_id: value.client, scope: faults.missingScope ? "" : value.scopes.join(" "), iss: issuer, exp: value.expires, token_type: "Bearer" });
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(origin), scopesSupported: scopes, resourceServerUrl: new URL(`${origin}/deployment-a/mcp`) }));
  for (const deployment of ["deployment-a", "deployment-b"]) {
    const path = `/${deployment}/mcp`;
    app.post(path, (request, response, next) => {
      if (faults.redirectRuntime) { response.redirect(307, `${origin}/deployment-a/mcp`); return; }
      if (faults.publicRuntime) { next(); return; }
      const token = request.headers.authorization?.replace(/^Bearer /u, "");
      if (token && access.get(token)?.resource !== `${origin}${path}`) metrics.rejectedAudience++;
      requireBearerAuth({ verifier: provider, requiredScopes: scopes, resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource${path}`,
        ...(faults.ignoreAudience ? {} : { expectedResource: new URL(`${origin}${path}`) }) })(request, response, next);
    }, async (request, response, next) => {
      const mcp = new McpServer({ name: "protected-technical-fixture", version: deployment });
      mcp.registerTool("echo", { description: "Repeat a supplied technical string.", inputSchema: faults.changedSchema
        ? z.object({ value: z.number() }).strict() : z.object({ text: z.string() }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }, async (args: Record<string, unknown>) => {
        metrics.toolCalls++;
        return { content: [{ type: "text" as const, text: JSON.stringify(args) }], structuredContent: args };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      live.add(mcp);
      response.on("close", () => { live.delete(mcp); void mcp.close().catch(() => undefined); });
      if (request.body?.method === "initialize") metrics.initialized++;
      try { await mcp.connect(transport); await transport.handleRequest(request, response, request.body); } catch (error) { next(error); }
    });
  }
  return {
    origin, issuer, metrics, faults,
    /** Explicit synthetic owner consent, used only by tests acting as the local fixture browser. */
    async approve(authorizationUrl: URL, options: { corruptState?: boolean } = {}): Promise<void> {
      const page = await fetch(authorizationUrl, { redirect: "error" });
      const html = await page.text();
      const requestId = /name="request_id" value="([^"]+)"/.exec(html)?.[1];
      if (!requestId) throw new Error("Local fixture consent page was unavailable.");
      const consent = await fetch(`${origin}/consent`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ request_id: requestId, owner_secret: ownerConsent, decision: "approve" }), redirect: "manual" });
      const callback = new URL(consent.headers.get("location")!);
      if (options.corruptState) callback.searchParams.set("state", "wrong-state");
      const response = await fetch(callback, { redirect: "error" }); await response.body?.cancel();
    },
    /** Synthetic credentials support the explicit env-reference path without browser login. */
    credential(resource = `${origin}/deployment-a/mcp`, environment: OAuthCredential["environment"] = "local"): OAuthCredential {
      const client = { client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: [], token_endpoint_auth_method: "none" as const };
      clients.set(client.client_id, client);
      return { issuer, environment, resource, audience: resource, obtained_at: Math.floor(Date.now() / 1000), client, tokens: issue(client.client_id, resource) };
    },
    async close() {
      await Promise.all([...live].map((mcp) => mcp.close()));
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    },
  };
}
