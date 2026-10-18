import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { createDemoMcpApp } from "../../src/demo-mcp.js";

// Loopback-only protocol test. No database, account, credential, or external service.
let http: Server;
let origin: string;
const clientFetch = globalThis.fetch.bind(globalThis);
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "synthetic-test", version: "1" },
} };
const call = (text: unknown) => ({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "word_count", arguments: { text } } });
function post(body: unknown, extra: Record<string, string> = {}) {
  return clientFetch(`${origin}/demo/mcp`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  http = createServer(createDemoMcpApp());
  await new Promise<void>((resolve) => { http.listen(0, "127.0.0.1", resolve); });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await new Promise<void>((resolve, reject) => http.close((e) => e ? reject(e) : resolve())); });

describe("public stateless synthetic MCP candidate", () => {
  it("initializes without cookies or a stateful session", async () => {
    const response = await post(initialize);
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ result: { serverInfo: { name: "tooltuner-textkit-demo", version: "candidate-v2" } } });
  });
  it("lists only word_count and counts mixed whitespace correctly", async () => {
    const listing = await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
    const catalog = await listing.json() as { result: { tools: { name: string }[] } };
    expect(catalog.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["word_count"]);
    expect(await (await post(call("alpha  beta\ngamma"))).json()).toMatchObject({ result: { structuredContent: { count: 3 } } });
    expect(await (await post(call("one two"))).json()).toMatchObject({ result: { structuredContent: { count: 2 } } });
  });
  it.each([
    ["", 0], ["   ", 0], ["\t\n\r ", 0], ["single", 1],
    ["  alpha   beta  ", 2], ["alpha\tbeta", 2], ["alpha\nbeta\r\ngamma", 3],
    [" alpha\t beta\ngamma ", 3], ["alpha\u00a0beta\u2003gamma", 3],
  ])("counts whitespace-delimited words in %j", async (text, expected) => {
    const body = await (await post(call(text))).json();
    expect(body).toMatchObject({ result: { structuredContent: { count: expected } } });
  });
  it("handles independent concurrent requests without session state", async () => {
    const bodies = await Promise.all(["one", "one two three", ""].map(async (text) => (await post(call(text))).json() as Promise<{ result: { structuredContent: { count: number } } }>));
    expect(bodies.map((body) => body.result.structuredContent.count)).toEqual([1, 3, 0]);
  });
  it("does not consult gateway configuration or forward supplied credentials", async () => {
    vi.stubEnv("TOOLTUNER_RUNTIME_MODE", "invalid-test-value");
    vi.stubEnv("FALKORDB_URL", "invalid-test-value");
    vi.stubEnv("SUPABASE_URL", "invalid-test-value");
    const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected outgoing request"));
    try {
      const result = await post(call("a b"), { authorization: "Bearer synthetic-test-only", cookie: "synthetic=test-only" });
      const body = await result.text();
      expect(result.status).toBe(200);
      expect(body).not.toContain("synthetic-test-only");
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(outbound).not.toHaveBeenCalled();
    } finally { outbound.mockRestore(); vi.unstubAllEnvs(); }
  });
  it("rejects oversized or invalid tool inputs", async () => {
    for (const text of ["x".repeat(4001), 42]) {
      const body = await (await post(call(text))).json() as { error?: unknown; result?: { isError?: boolean } };
      expect(body.error !== undefined || body.result?.isError === true).toBe(true);
    }
    const response = await post(call("x".repeat(20_000)));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_too_large" });
  });
  it("rejects unsupported methods and unknown tools without extra capabilities", async () => {
    for (const method of ["GET", "DELETE", "PUT"]) {
      const response = await clientFetch(`${origin}/demo/mcp`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const response = await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "fetch_url", arguments: { url: "https://example.invalid" } } });
    const body = await response.json() as { error?: unknown; result?: { isError?: boolean } };
    expect(body.error !== undefined || body.result?.isError === true).toBe(true);
  });
  it("returns sanitized malformed-JSON errors", async () => {
    const response = await clientFetch(`${origin}/demo/mcp`, { method: "POST", headers, body: "{bad-synthetic-input" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
  });
});
