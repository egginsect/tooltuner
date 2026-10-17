import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Grant, newId, canonicalDigest, type OperationContext, type Version, type ToolGroup } from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, getVersion, getStable, insertVersion, versionDigest } from "../../src/db/registry.js";
import { EVIDENCE_INDEX_SPECS, getCall, getPacket, getEvidence } from "../../src/db/evidence.js";
import { EXPERIMENT_INDEX_SPECS, getEvaluation, updateEvaluation } from "../../src/db/experiments.js";
import { createEvidenceService } from "../../src/flywheel/evidence.js";
import { createExperimentService, createTrustedExperimentReplay, type ExperimentServiceOptions } from "../../src/flywheel/experiments.js";
import { createGatewayCore } from "../../src/gateway/core.js";
import { callUpstream, readUpstreamCatalog } from "../../src/gateway/upstream.js";
import { startFixtureServer, REPRODUCTION } from "../../fixtures/server.js";
import { seedConfiguredFixtures } from "../../fixtures/registry.js";

let db: GraphClient;
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
let baseline: Version;
let candidate: Version;
let ctx: OperationContext;
let inputRef: string;
let options: ExperimentServiceOptions;
let calls = 0;
const ownerId = `experiments_${randomUUID()}`;
function context(groups: ToolGroup[] = ["management", "user"]): OperationContext {
  const grant = Grant.parse({ schema_version: 1, owner_id: ownerId, grant_id: newId("grant"), label: "experiment integration", groups,
    allow: { apps: ["textkit"], repos: ["test-fixture"] }, created_at: new Date().toISOString() });
  return { grant, principal: { owner_id: ownerId, grant_id: grant.grant_id, subject: "test", client_id: "test", session_id: "test-session" }, call_id: newId("call") };
}
beforeAll(async () => {
  db = await GraphClient.connect({ url: process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379", graph: `experiments_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, [...REGISTRY_INDEX_SPECS, ...EVIDENCE_INDEX_SPECS, ...EXPERIMENT_INDEX_SPECS]);
  fixture = await startFixtureServer({ onCall: () => { calls++; } });
  const seeds = await seedConfiguredFixtures(db, { owner_id: ownerId, baseUrl: fixture.baseUrl, source: { repo_id: "test-fixture", commit_sha: "a".repeat(40) }, initializeStable: true });
  baseline = seeds.versions.find((v) => v.application === "textkit")!;
  const target = { ...baseline, version_id: newId("version"), label: "local-example-v2", parent_version_id: baseline.version_id,
    runtime_target: { ...baseline.runtime_target, url: `${fixture.baseUrl}/textkit/example-v2/mcp`, deployment_id: "local:comparison-example-v2" } };
  const tools = await readUpstreamCatalog(target);
  const content = { ...target, tools, schema_digest: canonicalDigest({ tools }) };
  candidate = await insertVersion(db, { ...content, digest: versionDigest(content) });
  ctx = context();
  const gateway = createGatewayCore({ db, ...createEvidenceService(db) });
  const original = await gateway.dispatch(ctx, { application: "textkit", version: baseline.version_id, tool: "word_count", args: { ...REPRODUCTION.args } });
  inputRef = original.call_ref;
  options = { db, getPacket, getCall, getEvidence, getVersion: (owner, app, id) => getVersion(db, owner, app, id),
    configs: [{ ref: "config:fixture-v1", fixtureStateRef: "fixture:pure-word-count-v1", expectedOutput: { content: [{ type: "text", text: JSON.stringify(REPRODUCTION.expected) }], structuredContent: REPRODUCTION.expected }, maxVersions: 4 }],
    replay: createTrustedExperimentReplay({ db, recorder: createEvidenceService(db).recorder, getVersion: (owner, app, id) => getVersion(db, owner, app, id), invokePinned: (version, tool, args) => callUpstream(version, tool, args) }) };
});
afterAll(async () => {
  if (fixture) await fixture.close();
  if (db) { try { await db.dropGraph(); } finally { await db.close(); } }
});
const request = (key: string) => ({ application: "textkit", version_ids: [baseline.version_id, candidate.version_id], input_ref: inputRef, criterion_ref: "criterion:expected-output", config_ref: "config:fixture-v1", idempotency_key: key });

describe("real pinned comparison and separate durable recommendation", () => {
  it("replays actual persisted input through MCP for both exact versions, records actual refs and recommends without changing stable", async () => {
    const service = createExperimentService(options);
    const before = calls;
    const result = await service.run_experiment(ctx, request("comparison"));
    expect(result.state).toBe("completed");
    expect(calls - before).toBe(2);
    const evaluation = (await service.get_experiment(ctx, { evaluation_id: result.evaluation_id })).evaluation;
    expect(evaluation.results.map((r) => r.task_outcome)).toEqual(["fail", "pass"]);
    expect(evaluation.missing_items).toEqual([]);
    for (const row of evaluation.results) {
      expect(row.call_ref).toMatch(/^call_/);
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
      expect(row.cost_usd).toBeNull();
      expect(await getCall(db, ownerId, row.call_ref!)).toMatchObject({ resolved_version: row.version_id, outcome: "success" });
    }
    const suggestion = { evaluation_ids: [result.evaluation_id], version_ids: [candidate.version_id], reason: "The local synthetic preview passes the frozen word-count criterion; hosted OAuth and live job/deployment remain unverified." };
    const recommended = await service.recommend_candidate(ctx, suggestion);
    expect(await service.recommend_candidate(ctx, suggestion)).toEqual(recommended);
    expect((await getStable(db, ownerId, "textkit"))?.version_id).toBe(baseline.version_id);
    const links = await db.roQuery<{ n: number }>("MATCH (r:Recommendation)-[:FROM]->(e:Evaluation)-[:RAN]->(c:Call) RETURN count(c) AS n");
    expect(links[0]?.n).toBe(2);
    const reader = context(["development"]);
    const evidence = await createEvidenceService(db).handlers.get_context!(reader, { application: "textkit", version: baseline.version_id, call_ref: inputRef, limit: 50 });
    expect(evidence.items.some((item) => item.ref === result.evaluation_id)).toBe(true);
    expect(evidence.lineage).toContainEqual({ from: result.evaluation_id, rel: "COMPARES", to: baseline.version_id });
    const scalar = await db.roQuery<{ at: string }>("MATCH (e:Evaluation {evaluation_id:$id}) RETURN e.created_at AS at", { id: result.evaluation_id });
    expect(scalar[0]?.at).toBe(evaluation.created_at);
    const reconnect = await GraphClient.connect({ url: process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379", graph: db.graphName });
    try {
      const restarted = createExperimentService({ ...options, db: reconnect });
      const again = await restarted.run_experiment(ctx, request("comparison"));
      expect(again).toEqual(result);
      expect(calls - before).toBe(2);
      expect((await getEvaluation(reconnect, ownerId, result.evaluation_id))?.recommendation_refs).toEqual([recommended.recommendation_ref]);
    } finally { await reconnect.close(); }
    await expect(service.run_experiment(ctx, { ...request("comparison"), criterion_ref: "changed" })).rejects.toMatchObject({ shape: { code: "idempotency_conflict" } });
    await expect(service.recommend_candidate(ctx, { ...suggestion, version_ids: [baseline.version_id] })).rejects.toMatchObject({ shape: { code: "invalid_args" } });
  });
  it("runs MANAGEMENT-only safe internal trials while denying direct upstream and raw evidence reads", async () => {
    const manager = context(["management"]);
    const originalGrant = structuredClone(manager.grant);
    const service = createExperimentService(options);
    const before = calls;
    const evaluation = await service.run_experiment(manager, request("management-only"));
    expect(evaluation.state).toBe("completed");
    expect(calls - before).toBe(2);
    const saved = (await service.get_experiment(manager, { evaluation_id: evaluation.evaluation_id })).evaluation;
    expect(saved.results.map((result) => result.task_outcome)).toEqual(["fail", "pass"]);
    for (const result of saved.results) expect((await getCall(db, ownerId, result.call_ref!))?.grant_id).toBe(manager.grant.grant_id);
    const gateway = createGatewayCore({ db, ...createEvidenceService(db) });
    await expect(gateway.dispatch(manager, { application: "textkit", version: baseline.version_id, tool: "word_count", args: REPRODUCTION.args })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(createEvidenceService(db).handlers.get_evidence!(manager, { refs: [inputRef] })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(service.run_experiment(context(["development"]), request("development-only"))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(calls - before).toBe(2);
    expect(manager.grant).toEqual(originalGrant);
  });
  it("checks repository, tool and app scope on internal trials without requiring USER", async () => {
    const service = createExperimentService(options);
    const before = calls;
    for (const denied of ["repo", "tool", "app"]) {
      const manager = context(["management"]);
      if (denied === "repo") manager.grant.allow.repos = [];
      if (denied === "tool") manager.grant.allow.tools = { textkit: [] };
      if (denied === "app") manager.grant.allow.apps = [];
      await expect(service.run_experiment(manager, request(`denied-${denied}`))).rejects.toMatchObject({ shape: { code: denied === "app" ? "not_found" : "forbidden" } });
    }
    expect(calls).toBe(before);
  });
  it("rejects tampering at the internal persisted-trial boundary before transport", async () => {
    const before = calls;
    const transport = createTrustedExperimentReplay({ db, recorder: createEvidenceService(db).recorder,
      getVersion: (owner, app, id) => getVersion(db, owner, app, id), invokePinned: (version, tool, args) => callUpstream(version, tool, args) });
    const service = createExperimentService({ ...options, replay: async (ctx, trial) => {
      for (const forged of [{ ...trial, args: { text: "unfrozen" } }, { ...trial, version_digest: canonicalDigest({ forged: true }) },
        { ...trial, fixture_state_ref: "fixture:forged" }, { ...trial, idempotency_key: "forged" }, { ...trial, evaluation_id: newId("evaluation") }]) {
        await expect(transport(ctx, forged)).rejects.toMatchObject({ shape: { code: "forbidden" } });
      }
      return transport(ctx, trial);
    } });
    expect((await service.run_experiment(context(["management"]), request("tamper-boundary"))).state).toBe("completed");
    expect(calls - before).toBe(2);
  });
  it("refuses a pinned tool without read-only, non-destructive effects before any trial starts", async () => {
    const before = calls;
    for (const effects of [{ read_only: false, destructive: false }, { read_only: true, destructive: true }]) {
      const unsafe = createExperimentService({ ...options, getVersion: async (owner, app, id) => {
        const version = await options.getVersion(owner, app, id);
        return version && id === candidate.version_id ? { ...version, tools: version.tools.map((tool) => ({ ...tool, effects: { ...tool.effects, ...effects } })) } : version;
      } });
      await expect(unsafe.run_experiment(context(["management"]), request(`unsafe-${effects.read_only}`))).rejects.toMatchObject({ shape: { code: "forbidden" } });
    }
    expect(calls).toBe(before);
  });
  it("persists unavailable and missing arms, refuses recommendation, and never invents zero latency or success", async () => {
    const before = calls;
    const service = createExperimentService({ ...options, replay: undefined });
    const result = await service.run_experiment(ctx, { ...request("not-configured"), version_ids: [baseline.version_id, newId("version")] });
    const evaluation = (await service.get_experiment(ctx, { evaluation_id: result.evaluation_id })).evaluation;
    expect(evaluation.state).toBe("failed");
    expect(evaluation.results).toEqual([]);
    expect(evaluation.missing_items).toContain("replay-adapter:not-configured");
    expect(evaluation.missing_items.some((m) => m.endsWith(":UNVERIFIED"))).toBe(true);
    expect(calls).toBe(before);
    await expect(service.recommend_candidate(ctx, { evaluation_ids: [result.evaluation_id], version_ids: [baseline.version_id], reason: "unsupported" })).rejects.toMatchObject({ shape: { code: "invalid_args" } });
  });
  it("records lost completion as uncertain without repeating the actual call", async () => {
    const before = calls;
    const service = createExperimentService({ ...options, replay: async (context, input) => { await options.replay!(context, input); throw new Error("test-owned lost return receipt"); } });
    const result = await service.run_experiment(ctx, request("lost-receipt"));
    const evaluation = (await service.get_experiment(ctx, { evaluation_id: result.evaluation_id })).evaluation;
    expect(evaluation.state).toBe("failed");
    expect(evaluation.results.map((r) => [r.task_outcome, r.latency_ms, r.call_ref])).toEqual([["unknown", null, null], ["unknown", null, null]]);
    expect(calls - before).toBe(2);
    await service.run_experiment(ctx, request("lost-receipt"));
    expect(calls - before).toBe(2);
  });
  it("marks an interrupted comparison unverified on restart and refuses to replay it", async () => {
    const service = createExperimentService(options);
    const result = await service.run_experiment(ctx, request("interrupted"));
    const old = (await getEvaluation(db, ownerId, result.evaluation_id))!;
    await updateEvaluation(db, old, { ...old, state: "running", results: old.results.slice(0, 1) });
    const before = calls;
    const restarted = createExperimentService(options);
    const saved = (await restarted.get_experiment(ctx, { evaluation_id: result.evaluation_id })).evaluation;
    expect(saved).toMatchObject({ state: "failed", completeness: { status: "unknown" } });
    expect(saved.missing_items).toContain("interrupted-comparison:remaining-arms-UNVERIFIED:no-automatic-replay");
    expect((await restarted.run_experiment(ctx, request("interrupted"))).state).toBe("failed");
    expect(calls).toBe(before);
  });
});
