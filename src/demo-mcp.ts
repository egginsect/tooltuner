import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** Public synthetic demo only: no storage, environment, credentials, or outgoing requests. */
export function createDemoMcpApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => { response.setHeader("Cache-Control", "no-store"); next(); });
  app.use(express.json({ limit: "16kb", strict: true }));
  const paths = ["/demo/mcp", "/api/demo-mcp"];
  app.post(paths, async (request, response, next) => {
    const server = new McpServer({ name: "tooltuner-textkit-demo", version: "baseline-v1" });
    server.registerTool("word_count", {
      description: "Count words in synthetic demo text. Do not send private or sensitive data.",
      inputSchema: z.object({ text: z.string().max(4000) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ text }) => {
      // Preserve the existing baseline exactly. Change only after actual user feedback.
      const value = { count: text.split(" ").filter(Boolean).length };
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    response.once("close", () => { void server.close().catch(() => undefined); });
    try { await server.connect(transport); await transport.handleRequest(request, response, request.body); }
    catch (error) { next(error); }
  });
  app.all(paths, (_request, response) => { response.status(405).set("Allow", "POST").end(); });
  app.use((_request, response) => { response.status(404).json({ error: "not_found" }); });
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (response.headersSent) return;
    const status = typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large" ? 413 : 400;
    response.status(status).json({ error: status === 413 ? "request_too_large" : "invalid_request" });
  });
  return app;
}
