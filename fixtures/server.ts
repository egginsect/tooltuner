import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export const REPRODUCTION = {
  application: "textkit", tool: "word_count", args: { text: "alpha  beta\ngamma" }, expected: { count: 3 }, baseline: { count: 2 },
} as const;

export interface FixtureServerOptions {
  port?: number;
  /** Test instrumentation only. Runs immediately before a real fixture tool executes. */
  onCall?: (application: string, version: string, tool: string) => void;
}

function buildFixture(application: "textkit" | "catalog", version: "v1" | "example-v2", options: FixtureServerOptions): McpServer {
  const mcp = new McpServer({ name: `fixture-${application}`, version });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const record = (tool: string) => options.onCall?.(application, version, tool);
  const result = (value: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value });
  if (application === "catalog") {
    mcp.registerTool("capabilities", { description: "Return a fixed technical capability catalog.", inputSchema: z.object({}).strict(), annotations }, async () => {
      record("capabilities");
      return result({ capabilities: ["json", "text", "unicode"] });
    });
  } else {
    mcp.registerTool("word_count", { description: "Count words in text.", inputSchema: z.object({ text: z.string().max(4000) }).strict(), annotations }, async ({ text }) => {
      record("word_count");
      // Deliberate baseline defect: only literal single spaces delimit words.
      const count = version === "v1" ? text.split(" ").filter(Boolean).length : (text.trim() === "" ? 0 : text.trim().split(/\s+/u).length);
      return result({ count });
    });
    mcp.registerTool("fail", { description: "Return a deterministic tool error for gateway verification.", inputSchema: z.object({}).strict(), annotations }, async () => {
      record("fail");
      return { content: [{ type: "text" as const, text: "Deliberate fixture tool error." }], isError: true };
    });
    mcp.registerTool("delay", { description: "A bounded slow read used to verify uncertain timeouts.", inputSchema: z.object({ milliseconds: z.number().int().min(0).max(2000) }).strict(), annotations }, async ({ milliseconds }) => {
      record("delay");
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      return result({ version, waited_ms: milliseconds });
    });
  }
  return mcp;
}

/** Real SDK Streamable HTTP endpoints; separate deployments are represented by fixed URL paths. */
export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<{ baseUrl: string; close(): Promise<void>; server: Server }> {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const live = new Set<McpServer>();
  app.post("/textkit/redirect/mcp", (_req, res) => { res.redirect(307, "/textkit/v1/mcp"); });
  app.post("/textkit/protocol-error/mcp", (req, res, next) => {
    if (req.body?.method !== "tools/call") { next(); return; }
    res.json({ jsonrpc: "2.0", id: req.body.id, error: { code: -32602, message: "Deliberate fixture JSON-RPC rejection." } });
  });
  for (const [path, application, version] of [
    ["/textkit/v1/mcp", "textkit", "v1"],
    ["/textkit/example-v2/mcp", "textkit", "example-v2"],
    ["/textkit/protocol-error/mcp", "textkit", "v1"],
    ["/catalog/v1/mcp", "catalog", "v1"],
  ] as const) {
    app.post(path, async (req, res, next) => {
      const mcp = buildFixture(application, version, options);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      live.add(mcp);
      res.on("close", () => { live.delete(mcp); void mcp.close().catch(() => undefined); });
      try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); }
      catch (error) { next(error); }
    });
    app.get(path, (_req, res) => { res.status(405).set("Allow", "POST").end(); });
    app.delete(path, (_req, res) => { res.status(405).set("Allow", "POST").end(); });
  }
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not obtain a loopback TCP port.");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, async close() {
    await Promise.all([...live].map((mcp) => mcp.close()));
    await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Pass a valid fixture TCP port.");
  const fixture = await startFixtureServer({ port });
  process.stderr.write(`Fixture MCP servers listening at ${fixture.baseUrl}; baseline v1 and catalog v1 are ready for explicit registration.\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void fixture.close(); });
}
