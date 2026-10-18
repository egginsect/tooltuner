import type { RequestHandler } from "express";

/** Align browser-only flows with the fixed issuer before setting host-only cookies.
 * Host is compared only; it never supplies a redirect destination or issuer.
 */
export function canonicalBrowserOrigin(publicOrigin: string): RequestHandler {
  const origin = new URL(publicOrigin);
  return (req, res, next) => {
    const path = req.path.toLowerCase();
    const authorize = /^\/authorize(?:\/|$)/.test(path);
    const browser = authorize || /^\/auth(?:\/|$)/.test(path) || /^\/oauth\/(?:owner-login|consent)(?:\/|$)/.test(path);
    if (!browser || req.get("host")?.toLowerCase() === origin.host.toLowerCase()) { next(); return; }
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    if (authorize && req.method === "GET") {
      const target = new URL("/authorize", origin);
      const query = req.originalUrl.indexOf("?");
      if (query !== -1) target.search = req.originalUrl.slice(query);
      res.redirect(302, target.href);
      return;
    }
    // Never replay submitted passwords, consent, or callbacks on another host.
    res.status(400).type("text").send("Use the canonical gateway URL and restart authorization from your client.");
  };
}
