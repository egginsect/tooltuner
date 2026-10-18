/**
 * Public MCP surface (TOO-77): OAuth routes, owner consent, and the bearer-
 * protected Streamable HTTP endpoint exposing exactly list_apps, describe and
 * dispatch. Every request re-reads the grant, so revocation is immediate.
 */
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { rateLimit, type Store, type Options as RateLimitOptions } from "express-rate-limit";
import { z } from "zod";
import { StorageError } from "../errors.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createOAuthMetadata, mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  FlywheelError,
  ListAppsInput,
  DescribeInput,
  type DescribeOutput,
  DispatchInput,
  type DispatchOutput,
  type Grant,
  type ListAppsOutput,
  type Principal,
} from "../contracts.js";
import { FLYWHEEL_SCOPE, isSafeOAuthRedirect, type AuthExtra, type FlywheelOAuthProvider } from "./oauth/provider.js";
import { renderConsentError } from "./oauth/consent.js";

import { mountHumanAuth } from "./auth/routes.js";
import type { HumanAuth } from "./auth/supabase.js";
import { clearFlow, flowCookie, readCookie, sessionCookie } from "./auth/browser.js";

export interface GatewayContext {
  principal: Principal;
  grant: Grant;
}

/** Transport-agnostic gateway core (src/gateway/core.ts). */
export interface GatewayCore {
  listApps(ctx: GatewayContext): Promise<ListAppsOutput>;
  describe(ctx: GatewayContext, input: DescribeInput): Promise<DescribeOutput>;
  dispatch(ctx: GatewayContext, input: DispatchInput): Promise<DispatchOutput>;
}

export interface GatewayMountOptions {
  provider: FlywheelOAuthProvider;
  humanAuth?: HumanAuth;
  core: GatewayCore;
  /** Public origin, e.g. https://flywheel.example.ngrok.app (issuer). */
  publicOrigin: string;
  /** Protected resource, `<publicOrigin>/mcp`. */
  resource: string;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  trustProxy?: string | number | boolean;
  rateLimitStore?: (endpoint: string) => Store;
}

const SERVER_INSTRUCTIONS = [
  "MCP Flywheel gives one stable connection to several applications and their versions.",
  "Call list_apps, then describe an application to see the inner tools your grant allows, then dispatch one of them.",
  "Omit `version` to use the stable version; pass a label like `v2` or a version id to pin a preview.",
  "To report a problem with a prior call, dispatch application `flywheel`, tool `report_feedback`, with the call_ref you received.",
].join(" ");

const json = (value: unknown) => JSON.stringify(value, null, 2);

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: json(value) }],
    structuredContent: value as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(error: unknown) {
  if (error instanceof StorageError) return toolResult({ error: {
    code: "storage_unavailable", message: "Storage is unavailable; retry when FalkorDB is healthy",
    retryable: true, outcome_certainty: error.outcomeCertainty,
  } }, true);
  if (error instanceof FlywheelError) return toolResult({ error: error.shape }, true);
  return toolResult(
    { error: { code: "upstream_error", message: "Internal gateway error", retryable: true, outcome_certainty: "unknown" } },
    true,
  );
}

export function buildMcpServer(core: GatewayCore, ctx: GatewayContext): McpServer {
  const server = new McpServer({ name: "mcp-flywheel", version: "0.1.0" }, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "list_apps",
    {
      title: "List applications",
      description: "Applications this connection's grant can see, with their stable version.",
      inputSchema: ListAppsInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return toolResult(await core.listApps(ctx));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "describe",
    {
      title: "Describe an application",
      description:
        "Inner tools of one application version allowed by this grant, with input schemas. Omitting version resolves stable; an unknown version fails without fallback.",
      inputSchema: DescribeInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return toolResult(await core.describe(ctx, args));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "dispatch",
    {
      title: "Call an inner tool",
      description:
        "Call one inner tool of an application at a pinned version. May perform writes. Returns call_ref for feedback.",
      inputSchema: DispatchInput,
      // Honest annotations: inner tools can write, so dispatch is not read-only.
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const out = await core.dispatch(ctx, args);
        return toolResult(out, out.outcome !== "success");
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}

export function mountGateway(app: Express, opts: GatewayMountOptions): void {
  const log = opts.log ?? (() => undefined);
  const issuerUrl = new URL(opts.publicOrigin);
  const resourceUrl = new URL(opts.resource);
  if (resourceUrl.href !== new URL("/mcp", issuerUrl).href || issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash || issuerUrl.username || issuerUrl.password) {
    throw new Error("Gateway issuer must be an origin and resource must be its /mcp endpoint");
  }
  // Local tunnels use loopback. Hosted limits are endpoint-global and never
  // derive a security key from unverified forwarding headers.
  app.set("trust proxy", opts.trustProxy ?? "loopback");
  const limits = (endpoint: string): Partial<RateLimitOptions> => opts.rateLimitStore
    ? { store: opts.rateLimitStore(endpoint), keyGenerator: () => "gateway", passOnStoreError: false }
    : {};

  // Compose maintained SDK handlers so metadata advertises only the public
  // PKCE clients this provider actually accepts (the convenience router also
  // advertises confidential clients, whose plaintext secrets we do not store).
  const oauthMetadata = createOAuthMetadata({ provider: opts.provider, issuerUrl, baseUrl: issuerUrl,
    scopesSupported: [FLYWHEEL_SCOPE] });
  oauthMetadata.token_endpoint_auth_methods_supported = ["none"];
  oauthMetadata.revocation_endpoint_auth_methods_supported = ["none"];
  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: resourceUrl,
    scopesSupported: [FLYWHEEL_SCOPE], resourceName: "MCP Flywheel" }));
  // Reject unsafe requested callbacks before SDK error redirects as well as
  // at the provider boundary (including malformed PKCE/resource requests).
  app.use("/authorize", express.urlencoded({ extended: false, limit: "16kb" }), (req: Request, res: Response, next: NextFunction) => {
    const uri: unknown = req.method === "POST" ? req.body?.redirect_uri : req.query.redirect_uri;
    if (typeof uri === "string" && !isSafeOAuthRedirect(uri)) {
      res.status(400).set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }).type("html")
        .send(renderConsentError("Invalid callback. Use HTTPS or loopback HTTP without credentials or fragments."));
      return;
    }
    next();
  }, authorizationHandler({ provider: opts.provider, rateLimit: limits("authorize") }));
  app.use("/token", tokenHandler({ provider: opts.provider, rateLimit: limits("token") }));
  app.use("/register", clientRegistrationHandler({ clientsStore: opts.provider.clientsStore, rateLimit: limits("register") }));
  app.use("/revoke", revocationHandler({ provider: opts.provider, rateLimit: limits("revoke") }));

  const consentHeaders = (_req: Request, res: Response, next: NextFunction) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
    next();
  };
  app.use(["/oauth/owner-login", "/oauth/consent"], consentHeaders);
  if (opts.provider.multiuser) {
    if (!opts.humanAuth) throw new Error("Multiuser OAuth requires Supabase authentication");
    mountHumanAuth(app, { auth: opts.humanAuth, provider: opts.provider, origin: opts.publicOrigin,
      limiter: rateLimit({ windowMs: 15 * 60_000, limit: 40, standardHeaders: true, legacyHeaders: false, ...limits("human-auth") }) });
  }
  app.post("/oauth/owner-login",
    rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, ...limits("owner-login") }),
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req: Request, res: Response) => {
      const parsed = z.object({ request_id: z.string().min(1).max(128), owner_secret: z.string().max(4096) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).type("html").send(renderConsentError("Invalid owner login form. Restart the connection from your client."));
        return;
      }
      const outcome = await opts.provider.authenticateOwner({ requestId: parsed.data.request_id, ownerSecret: parsed.data.owner_secret });
      if ("html" in outcome) res.status(200).type("html").send(outcome.html);
      else res.status(outcome.status).type("html").send(renderConsentError(outcome.error));
    });

  app.post(
    "/oauth/consent",
    rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, ...limits("consent") }),
    express.urlencoded({ extended: false, limit: "16kb" }),
    async (req: Request, res: Response) => {
      res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
      const parsed = z.object({
        request_id: z.string().min(1).max(128),
        grant_id: z.string().max(128).optional(),
        selection_token: z.string().max(128).optional(),
        decision: z.enum(["approve", "deny"]),
      }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).type("html").send(renderConsentError("Invalid consent form. Restart the connection from your client."));
        return;
      }
      const body = parsed.data;
      let userId: string | undefined;
      let browserToken: string | undefined;
      if (opts.provider.multiuser) {
        browserToken = readCookie(req, flowCookie(body.request_id));
        if (req.get("origin") !== opts.publicOrigin || !await opts.provider.checkBrowser(body.request_id, browserToken)) {
          res.status(403).type("html").send(renderConsentError("Consent requires the original browser request.")); return;
        }
        try { userId = await opts.humanAuth!.user(readCookie(req, sessionCookie(body.request_id))); }
        catch { clearFlow(res, body.request_id); res.status(403).type("html").send(renderConsentError("Sign-in expired. Restart the connection.")); return; }
      }
      const outcome = await opts.provider.completeConsent({
        requestId: body.request_id, userId, browserToken,
        grantId: body.grant_id ?? "",
        selectionToken: body.selection_token,
        approve: body.decision === "approve",
      });
      if ("redirectTo" in outcome) {
        if (opts.provider.multiuser) clearFlow(res, body.request_id);
        log("oauth consent completed", { approved: body.decision === "approve", grant_id: body.grant_id });
        res.redirect(302, outcome.redirectTo);
      } else {
        res.status(outcome.status).type("html").send(renderConsentError(outcome.error));
      }
    },
  );

  const bearer = requireBearerAuth({
    verifier: opts.provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    expectedResource: resourceUrl,
    requiredScopes: [FLYWHEEL_SCOPE],
  });

  const handleMcp = async (req: Request & { auth?: AuthInfo }, res: Response) => {
    const extra = req.auth?.extra as AuthExtra | undefined;
    if (!extra) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    let grant: Grant;
    try {
      grant = await opts.provider.loadGrant(extra.principal);
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) throw error;
      res
        .status(401)
        .set("WWW-Authenticate", `Bearer error="invalid_token", resource_metadata="${getOAuthProtectedResourceMetadataUrl(resourceUrl)}"`)
        .json({ error: "invalid_token", error_description: "The grant behind this token was revoked" });
      return;
    }
    const server = buildMcpServer(opts.core, { principal: extra.principal, grant });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  app.post("/mcp", express.json({ limit: "1mb" }), bearer, (req, res, next) => {
    handleMcp(req, res).catch(next);
  });
  // Stateless server: no standalone SSE stream and no sessions to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ error: "method_not_allowed" });
  };
  app.get("/mcp", bearer, notAllowed);
  app.delete("/mcp", bearer, notAllowed);
  app.use(["/auth", "/mcp", "/authorize", "/token", "/register", "/revoke", "/oauth/owner-login", "/oauth/consent"], (error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const storage = error instanceof StorageError;
    const status = storage ? 503 : (error as { status?: number })?.status === 400 ? 400 : 500;
    res.status(status).json({ error: { code: storage ? "storage_unavailable" : status === 400 ? "invalid_args" : "upstream_error",
      message: storage ? "Storage is unavailable; retry when FalkorDB is healthy" : "The gateway could not process this request",
      retryable: status >= 500, outcome_certainty: storage ? error.outcomeCertainty : "not_executed" } });
  });
}
