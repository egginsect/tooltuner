import type { Request, Response } from "express";
import { expect, it, vi } from "vitest";
import { canonicalBrowserOrigin } from "../../src/gateway/auth/canonical.js";

function invoke(path: string, method: string, host: string, originalUrl = path) {
  const res = { set: vi.fn(() => res), redirect: vi.fn(), status: vi.fn(() => res), type: vi.fn(() => res), send: vi.fn() };
  const next = vi.fn();
  const req = { path, method, originalUrl, get: (name: string) => name === "host" ? host : "attacker.example" } as Request;
  canonicalBrowserOrigin("https://branch.example")(req, res as unknown as Response, next);
  return { res, next };
}

it("redirects a deployment-alias authorization GET to the fixed branch origin before downstream cookies", () => {
  const { res, next } = invoke("/authorize", "GET", "deployment.example", "/authorize?client_id=synthetic&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=a%2Bb");
  expect(res.redirect).toHaveBeenCalledWith(302, "https://branch.example/authorize?client_id=synthetic&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=a%2Bb");
  expect(res.set).toHaveBeenCalledWith({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  expect(next).not.toHaveBeenCalled();
});

it("never derives redirect destinations from an absolute request target or forwarded headers", () => {
  const { res } = invoke("/authorize", "GET", "attacker.example", "https://attacker.example/authorize?next=https://attacker.example");
  expect(res.redirect).toHaveBeenCalledWith(302, "https://branch.example/authorize?next=https://attacker.example");
  expect(invoke("/authorize", "GET", "BRANCH.EXAMPLE").next).toHaveBeenCalledOnce();
});

it("rejects off-origin browser mutations and callbacks without redirecting or consuming input", () => {
  for (const [path, method] of [["/authorize", "POST"], ["/auth/password", "POST"], ["/auth/google", "POST"], ["/auth/logout", "POST"], ["/auth/callback", "GET"], ["/oauth/owner-login", "POST"], ["/oauth/consent", "POST"]]) {
    const { res, next } = invoke(path!, method!, "deployment.example");
    expect(res.status).toHaveBeenCalledWith(400); expect(res.redirect).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
    expect(invoke(path!, method!, "branch.example").next).toHaveBeenCalledOnce();
  }
});

it("does not redirect token, registration, revocation, metadata or MCP protocol requests", () => {
  for (const path of ["/token", "/register", "/revoke", "/mcp", "/.well-known/oauth-authorization-server"])
    expect(invoke(path, "POST", "deployment.example").next).toHaveBeenCalledOnce();
});
