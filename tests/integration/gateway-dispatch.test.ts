import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import express from "express";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  Grant, DispatchOutput, canonicalDigest, newId, type Version, type CallRecorder, type ToolGroup,
} from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, getStable, insertVersion, versionDigest } from "../../src/db/registry.js";
import { EVIDENCE_INDEX_SPECS, getCall } from "../../src/db/evidence.js";
import { createEvidenceService } from "../../src/flywheel/evidence.js";
import { createGatewayCore, type GatewayCoreOptions } from "../../src/gateway/core.js";
import { buildMcpServer, type GatewayContext } from "../../src/gateway/mcp.js";
import { readUpstreamCatalog } from "../../src/gateway/upstream.js";
import { activateVersion } from "../../src/cli/versions.js";
import { startFixtureServer, REPRODUCTION } from "../../fixtures/server.js";
import { seedConfiguredFixtures } from "../../fixtures/registry.js";

const url = process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379";
let db: GraphClient;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let service: ReturnType<typeof createEvidenceService>;
let baseline: Version;
let calls: { application: string; version: string; tool: string }[];
const owner = { owner_id: "owner", subject: "isolated-test-owner" };
let ctx: GatewayContext;

function context(groups: ToolGroup[] = ["user"], ownerId = "owner"): GatewayContext {
  const grant = Grant.parse({ schema_version: 1, owner_id: ownerId, grant_id: newId("grant"), label: "integration", groups,
    allow: { apps: ["*"], tools: {} }, created_at: new Date().toISOString() });
  return { grant, principal: { owner_id: ownerId, grant_id: grant.grant_id, subject: "test", client_id: "client", session_id: "session" } };
}
const core = (options: Partial<GatewayCoreOptions> = {}) => createGatewayCore({ db, ...service, ...options });
const dispatchInput = (extra: Record<string, unknown> = {}) => ({ application: "textkit", tool: "word_count", args: { ...REPRODUCTION.args }, ...extra });

async function registerExample(): Promise<Version> {
  const target = { ...baseline, version_id: newId("version"), label: "example-v2", parent_version_id: baseline.version_id,
    runtime_target: { ...baseline.runtime_target, url: `${fixture.baseUrl}/textkit/example-v2/mcp`, deployment_id: "local:test-example-v2" } };
  const tools = await readUpstreamCatalog(target);
  const content = { ...target, tools, schema_digest: canonicalDigest({ tools }) };
  return insertVersion(db, { ...content, digest: versionDigest(content) });
}

beforeEach(async () => {
  calls = [];
  db = await GraphClient.connect({ url, graph: `gateway_dispatch_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, [...REGISTRY_INDEX_SPECS, ...EVIDENCE_INDEX_SPECS]);
  fixture = await startFixtureServer({ onCall: (application, version, tool) => { calls.push({ application, version, tool }); } });
  const seeds = await seedConfiguredFixtures(db, { owner_id: "owner", baseUrl: fixture.baseUrl,
    source: { repo_id: "explicit-integration-fixture", commit_sha: "a".repeat(40) }, initializeStable: true });
  baseline = seeds.versions.find((v) => v.application === "textkit")!;
  service = createEvidenceService(db);
  ctx = context();
});
afterEach(async () => {
  try { await fixture?.close(); }
  finally { if (db) { try { await db.dropGraph(); } finally { await db.close(); } } }
});

describe("real graph recorder and MCP gateway", () => {
  it("calls two independent apps over one outer SDK connection and persists results", async () => {
    const app = express();
    app.use(express.json());
    const gateway = core();
    app.post("/mcp", async (req, res, next) => {
      const mcp = buildMcpServer(gateway, ctx);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void mcp.close(); });
      try { await mcp.connect(transport); await transport.handleRequest(req, res, req.body); } catch (error) { next(error); }
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing outer server port.");
    const client = new Client({ name: "gateway-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["list_apps", "describe", "dispatch"]);
      const apps = (await client.callTool({ name: "list_apps", arguments: {} })).structuredContent as { apps: { application: string }[] };
      expect(apps.apps.map((a) => a.application)).toEqual(["catalog", "textkit", "flywheel"]);
      const result = DispatchOutput.parse((await client.callTool({ name: "dispatch", arguments: dispatchInput() })).structuredContent);
      expect(result).toMatchObject({ outcome: "success", resolved_version: baseline.version_id, result: { structuredContent: REPRODUCTION.baseline } });
      const secondary = DispatchOutput.parse((await client.callTool({ name: "dispatch", arguments: { application: "catalog", tool: "capabilities", args: {} } })).structuredContent);
      expect(secondary).toMatchObject({ outcome: "success", result: { structuredContent: { capabilities: ["json", "text", "unicode"] } } });
      expect(await getCall(db, "owner", result.call_ref)).toMatchObject({ outcome: "success", resolved_version: baseline.version_id, requested_version: null });
      expect(calls.map((c) => c.application)).toEqual(["textkit", "catalog"]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
    }
  });

  it("replays a persisted key across restart and stable changes without new side effects", async () => {
    const gateway = core();
    const request = dispatchInput({ idempotency_key: "replay" });
    const first = await gateway.dispatch(ctx, request);
    const example = await registerExample();
    await activateVersion(db, owner, { application: "textkit", selected_version_id: example.version_id,
      expected_current_version_id: baseline.version_id, receipt: { test_only: true } });
    const reconnect = await GraphClient.connect({ url, graph: db.graphName });
    try {
      const replayCore = createGatewayCore({ db: reconnect, ...createEvidenceService(reconnect) });
      const replay = await replayCore.dispatch(ctx, request);
      expect(replay).toMatchObject({ call_ref: first.call_ref, resolved_version: baseline.version_id, outcome: "success" });
      expect(calls).toHaveLength(1);
      await expect(replayCore.dispatch(ctx, { ...request, args: { text: "different" } })).rejects.toMatchObject({ shape: { code: "idempotency_conflict" } });
    } finally { await reconnect.close(); }
  });

  it("pins stable once before admission even if an owner switches stable during admission", async () => {
    const example = await registerExample();
    const recorder: CallRecorder = { ...service.recorder, async admit(admission) {
      const admitted = await service.recorder.admit(admission);
      await activateVersion(db, owner, { application: "textkit", selected_version_id: example.version_id,
        expected_current_version_id: baseline.version_id, receipt: { test_only: true } });
      return admitted;
    } };
    const result = await core({ recorder }).dispatch(ctx, dispatchInput());
    expect(result).toMatchObject({ resolved_version: baseline.version_id, result: { structuredContent: REPRODUCTION.baseline } });
    expect((await getStable(db, "owner", "textkit"))?.version_id).toBe(example.version_id);
    const next = await core().dispatch(ctx, dispatchInput());
    expect(next).toMatchObject({ resolved_version: example.version_id, result: { structuredContent: REPRODUCTION.expected } });
    const pinned = await core().dispatch(ctx, dispatchInput({ version: "v1" }));
    expect(pinned.resolved_version).toBe(baseline.version_id);
  });

  it("validates and enforces tenant, group and tool restrictions before admission or network side effects", async () => {
    const gateway = core();
    await expect(gateway.dispatch(ctx, { ...dispatchInput(), args: { text: 123 } } as never)).rejects.toMatchObject({ shape: { code: "invalid_args", field_path: "args", outcome_certainty: "not_executed" } });
    await expect(gateway.dispatch(ctx, dispatchInput({ version: "missing" }))).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    await expect(gateway.dispatch(context(["user"], "other-owner"), dispatchInput())).rejects.toMatchObject({ shape: { code: "not_found" } });
    const restricted = { ...ctx, grant: { ...ctx.grant, allow: { ...ctx.grant.allow, tools: { textkit: ["fail"] } } } };
    expect((await gateway.describe(restricted, { application: "textkit" })).tools.map((t) => t.name)).toEqual(["fail"]);
    await expect(gateway.dispatch(restricted, dispatchInput())).rejects.toMatchObject({ shape: { code: "forbidden" } });
    const outOfScope = { ...ctx, grant: { ...ctx.grant, allow: { ...ctx.grant.allow, apps: ["catalog"] } } };
    expect((await gateway.listApps(outOfScope)).apps.map((a) => a.application)).not.toContain("textkit");
    await expect(gateway.dispatch(outOfScope, dispatchInput())).rejects.toMatchObject({ shape: { code: "not_found" } });
    await expect(gateway.dispatch(context(["development"]), dispatchInput())).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect((await gateway.listApps(context(["development"]))).apps.map((a) => a.application)).toEqual(["flywheel"]);
    const storedCalls = await db.roQuery<{ n: number }>("MATCH (c:Call) RETURN count(c) AS n");
    expect(storedCalls[0]?.n).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("shows real builtin group differences and enforces direct denials and unavailable operations", async () => {
    const gateway = core();
    const user = context(["user"]), dev = context(["development"]), management = context(["management"]);
    expect((await gateway.describe(user, { application: "flywheel" })).tools.map((t) => t.name)).toEqual(["report_feedback"]);
    expect((await gateway.describe(dev, { application: "flywheel" })).tools.map((t) => t.name)).toEqual(["get_context", "get_evidence"]);
    expect((await gateway.describe(management, { application: "flywheel" })).tools.map((t) => t.name)).toEqual(["create_packet"]);
    await expect(gateway.dispatch(user, { application: "flywheel", tool: "get_evidence", args: { refs: [baseline.version_id] } })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(gateway.dispatch(management, { application: "flywheel", tool: "get_context", args: { application: "textkit" } })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(gateway.dispatch(management, { application: "flywheel", tool: "start_job", args: {} })).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    const union = context(["user", "development", "management"]);
    expect((await gateway.describe(union, { application: "flywheel" })).tools).toHaveLength(4);
    for (const tool of ["merge", "activate", "rollback"]) await expect(gateway.dispatch(union, { application: "flywheel", tool, args: {} })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    const read = await gateway.dispatch(dev, { application: "flywheel", tool: "get_context", args: { application: "textkit" } });
    expect(read.outcome).toBe("success");
    expect((await getCall(db, "owner", read.call_ref))?.tool).toBe("get_context");
  });

  it("distinguishes real upstream tool errors and unknown timeouts and never re-executes unknown keys", async () => {
    const failed = await core().dispatch(ctx, { application: "textkit", tool: "fail", args: {} });
    expect(failed).toMatchObject({ outcome: "tool_error", error: { code: "upstream_error", outcome_certainty: "executed" } });
    const timeoutCore = core({ timeoutMs: 150 });
    const request = { application: "textkit", tool: "delay", args: { milliseconds: 800 }, idempotency_key: "timeout" };
    const timedOut = await timeoutCore.dispatch(ctx, request);
    expect(timedOut).toMatchObject({ outcome: "unknown", error: { code: "outcome_unknown", outcome_certainty: "unknown" } });
    expect(await getCall(db, "owner", timedOut.call_ref)).toMatchObject({ outcome: "unknown" });
    expect(await timeoutCore.dispatch(ctx, request)).toMatchObject({ call_ref: timedOut.call_ref, outcome: "unknown" });
    expect(calls.filter((c) => c.tool === "delay")).toHaveLength(1);
  });

  it("does not execute after real admission storage failure and retains call_ref after completion storage failure", async () => {
    const closed = await GraphClient.connect({ url, graph: db.graphName });
    const unavailable = createEvidenceService(closed);
    await closed.close();
    await expect(core({ recorder: unavailable.recorder }).dispatch(ctx, dispatchInput())).rejects.toMatchObject({ shape: { code: "storage_unavailable", outcome_certainty: "not_executed" } });
    expect(calls).toHaveLength(0);
    const recorder: CallRecorder = { ...service.recorder, complete: unavailable.recorder.complete.bind(unavailable.recorder) };
    const request = dispatchInput({ idempotency_key: "completion-failure" });
    const result = await core({ recorder }).dispatch(ctx, request);
    expect(result).toMatchObject({ outcome: "unknown", error: { code: "storage_unavailable", outcome_certainty: "executed" }, completeness: { status: "unknown" } });
    expect(await getCall(db, "owner", result.call_ref)).toMatchObject({ outcome: "unknown" });
    expect(await core().dispatch(ctx, request)).toMatchObject({ call_ref: result.call_ref, outcome: "unknown" });
    expect(calls).toHaveLength(1);
  });

  it("serializes concurrent idempotent admissions and performs exactly one local upstream call", async () => {
    const gateway = core();
    const request = dispatchInput({ idempotency_key: "concurrent" });
    const results = await Promise.all([gateway.dispatch(ctx, request), gateway.dispatch(ctx, request), gateway.dispatch(ctx, request)]);
    expect(new Set(results.map((r) => r.call_ref)).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("requires configured server credentials, does not fall back to another version, and keeps seeds explicit", async () => {
    const protectedContent = { ...baseline, version_id: newId("version"), label: "protected", auth_config_ref: "fixture:credential" };
    const protectedVersion = await insertVersion(db, { ...protectedContent, digest: versionDigest(protectedContent) });
    const result = await core().dispatch(ctx, dispatchInput({ version: protectedVersion.version_id }));
    expect(result).toMatchObject({ resolved_version: protectedVersion.version_id, outcome: "infra_error", error: { code: "operation_unavailable", outcome_certainty: "not_executed" } });
    expect(calls).toHaveLength(0);
    const unready = { ...baseline, version_id: newId("version"), label: "unready", state: "unavailable" as const };
    await insertVersion(db, unready);
    await expect(core().dispatch(ctx, dispatchInput({ version: "unready" }))).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    const seeds = await seedConfiguredFixtures(db, { owner_id: "owner", baseUrl: fixture.baseUrl,
      source: baseline.source, initializeStable: true });
    expect(seeds.versions.find((v) => v.application === "textkit")?.version_id).toBe(baseline.version_id);
    expect((await getStable(db, "owner", "textkit"))?.version_id).toBe(baseline.version_id);
  });

  it("records explicit protocol errors, rejects redirects and reports disappeared pinned deployments without fallback", async () => {
    for (const [label, path, outcome, code] of [
      ["protocol", "protocol-error", "protocol_error", "upstream_error"],
      ["redirect", "redirect", "infra_error", "upstream_error"],
      ["gone", "gone", "infra_error", "version_unavailable"],
    ] as const) {
      const content = { ...baseline, version_id: newId("version"), label, runtime_target: { ...baseline.runtime_target, url: `${fixture.baseUrl}/textkit/${path}/mcp` } };
      const registered = await insertVersion(db, { ...content, digest: versionDigest(content) });
      const result = await core().dispatch(ctx, dispatchInput({ version: registered.version_id }));
      expect(result).toMatchObject({ resolved_version: registered.version_id, outcome, error: { code, outcome_certainty: "not_executed" } });
      expect(await getCall(db, "owner", result.call_ref)).toMatchObject({ resolved_version: registered.version_id, outcome });
    }
    expect(calls).toHaveLength(0);
    expect((await getStable(db, "owner", "textkit"))?.version_id).toBe(baseline.version_id);
  });
});
