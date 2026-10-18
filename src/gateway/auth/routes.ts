/** Server-only sign-in for the current authorization request. No public signup or admin APIs. */
import { createHash, randomBytes } from "node:crypto";
import express, { type Express, type Request, type Response, type RequestHandler } from "express";
import { z } from "zod";
import type { FlywheelOAuthProvider } from "../oauth/provider.js";
import { renderConsentError } from "../oauth/consent.js";
import type { HumanAuth, HumanSession } from "./supabase.js";
import { clearFlow, flowCookie, readCookie, sessionCookie, verifierCookie, writeCookie } from "./browser.js";
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const formSchema = z.object({ request_id: idSchema, csrf: idSchema });
export function mountHumanAuth(app: Express, options: { auth: HumanAuth; provider: FlywheelOAuthProvider; origin: string; limiter: RequestHandler }): void {
  const { auth, provider, origin } = options;
  const failure = (res: Response, status = 403) => res.status(status).type("html").send(renderConsentError("Sign-in could not be completed. Restart the connection from your client."));
  app.use("/auth", (_req, res, next) => {
    res.set({ "Cache-Control": "private, no-store", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); next();
  }, options.limiter);
  async function checkForm(req: Request): Promise<{ id: string; browser: string } | null> {
    const parsed = formSchema.safeParse(req.body);
    if (req.get("origin") !== origin || !parsed.success) return null;
    const { request_id: id, csrf } = parsed.data;
    const browser = readCookie(req, flowCookie(id));
    return browser === csrf && await provider.checkBrowser(id, browser) ? { id, browser } : null;
  }
  async function finish(res: Response, id: string, browser: string, session: HumanSession) {
    const outcome = await provider.authenticateUser({ requestId: id, browserToken: browser, userId: session.userId });
    if ("html" in outcome) {
      writeCookie(res, sessionCookie(id), session.accessToken, session.expiresIn);
      writeCookie(res, verifierCookie(id), "", 0);
      res.status(200).type("html").send(outcome.html);
    } else { clearFlow(res, id); failure(res, outcome.status); }
  }
  app.post("/auth/password", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const flow = await checkForm(req);
    if (!flow) { failure(res); return; }
    const parsed = z.object({ email: z.string().email().max(320), password: z.string().min(1).max(4096) }).safeParse(req.body);
    if (!parsed.success) { failure(res, 400); return; }
    try { await finish(res, flow.id, flow.browser, await auth.password(parsed.data.email, parsed.data.password)); }
    catch { clearFlow(res, flow.id); failure(res); }
  });
  app.post("/auth/google", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const flow = await checkForm(req);
    if (!flow) { failure(res); return; }
    const verifier = randomBytes(32).toString("base64url");
    if (!await provider.browserOAuth(flow.id, flow.browser, verifier, false)) { failure(res); return; }
    writeCookie(res, verifierCookie(flow.id), verifier);
    const callback = new URL("/auth/callback", origin); callback.searchParams.set("request_id", flow.id);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    res.redirect(303, auth.authorizeUrl(callback.href, challenge));
  });
  app.get("/auth/callback", async (req, res) => {
    const parsed = z.object({ request_id: idSchema, code: z.string().min(1).max(2048) }).safeParse(req.query);
    if (!parsed.success) { failure(res, 400); return; }
    const { request_id: id, code } = parsed.data;
    const browser = readCookie(req, flowCookie(id)), verifier = readCookie(req, verifierCookie(id));
    if (!await provider.browserOAuth(id, browser, verifier, true)) { failure(res); return; }
    writeCookie(res, verifierCookie(id), "", 0);
    try { await finish(res, id, browser, await auth.exchange(code, verifier)); }
    catch { clearFlow(res, id); failure(res); }
  });
  app.post("/auth/logout", express.urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const flow = await checkForm(req);
    if (!flow) { failure(res); return; }
    clearFlow(res, flow.id);
    res.type("html").send("<p>Signed out of this authorization request. Existing MCP client grants are unchanged.</p>");
  });
}
