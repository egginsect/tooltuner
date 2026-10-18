import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  COMPLETE, Grant, Version, canonicalDigest, newId, provenanceOf, SCHEMA_VERSION,
  PACKET_DIGEST_EXCLUDED, GetContextOutput, GetEvidenceOutput, type OperationContext,
  type CallAdmission, type CallRecorder, type ToolGroup,
} from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, insertApplication, insertVersion, seedInitialStable, versionDigest } from "../../src/db/registry.js";
import { EVIDENCE_INDEX_SPECS, appendCallEvent, getCall, getEvidence, getPacket, getRecord } from "../../src/db/evidence.js";
import { createEvidenceService } from "../../src/flywheel/evidence.js";
import { StorageError } from "../../src/errors.js";
import { createGatewayCore } from "../../src/gateway/core.js";

const url = process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379";
const graph = `evidence_${randomUUID().replaceAll("-", "")}`;
let db: GraphClient;
let service: ReturnType<typeof createEvidenceService>;
let v1: Version;
let otherVersion: Version;

function context(groups: ToolGroup[] = ["user", "development", "management"], owner = "owner-a", apps = ["sample", "secondary"]): OperationContext {
  const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: owner, label: "evidence test", groups,
    allow: { apps, tools: {}, repos: ["repo-a", "repo-b"] }, scope: {}, created_at: new Date().toISOString() });
  return { grant, principal: { owner_id: owner, grant_id: grant.grant_id, subject: "session-a", client_id: "test-client", session_id: "test-session" }, call_id: newId("call") };
}

async function version(owner: string, app: string, repo: string): Promise<Version> {
  const base = { schema_version: SCHEMA_VERSION, owner_id: owner, created_at: new Date().toISOString(), provenance: provenanceOf("seed", null), completeness: COMPLETE };
  await insertApplication(db, { ...base, application: app, description: "Synthetic technical fixture", kind: "upstream" });
  const content = Version.parse({ ...base, version_id: newId("version"), digest: canonicalDigest({}), application: app,
    label: "v1", parent_version_id: null, source: { repo_id: repo, commit_sha: "a".repeat(40) }, tools: [],
    schema_digest: canonicalDigest({ tools: [] }), runtime_target: { kind: "mcp_streamable_http", url: "http://127.0.0.1:9001/mcp", deployment_id: null, environment: "local" },
    auth_config_ref: null, verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, state: "ready",
    readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } });
  content.digest = versionDigest(content);
  const saved = await insertVersion(db, content);
  await seedInitialStable(db, saved);
  return saved;
}

function admission(ctx: OperationContext, selected = v1, args: Record<string, unknown> = { text: "two words" }, key: string | null = null): CallAdmission {
  return { principal: ctx.principal, application: selected.application, tool: "word_count", requested_version: null,
    resolved_version: selected.version_id, schema_digest: selected.schema_digest, idempotency_key: key, args, causal_refs: [] };
}
async function call(ctx: OperationContext, args?: Record<string, unknown>, selected = v1): Promise<string> {
  const result = await service.recorder.admit(admission(ctx, selected, args));
  await service.recorder.complete(result.call_id, { outcome: "tool_error", result: { count: 1 }, error: null, duration_ms: 5 });
  return result.call_id;
}
const read = (ctx: OperationContext, refs: string[]) => service.handlers.get_evidence!(ctx, { refs });

/** Inject a transport failure around actual graph writes, without substituting persistence. */
function uncertainWrites(afterCommit: boolean): GraphClient {
  return new Proxy(db, { get(target, key) {
    if (key === "query") return async (...args: Parameters<GraphClient["query"]>) => {
      if (afterCommit) await target.query(...args);
      throw new StorageError("storage_unavailable", "Injected write transport timeout", { outcomeCertainty: "unknown" });
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) as unknown : value;
  } });
}

beforeAll(async () => {
  db = await GraphClient.connect({ url, graph });
  await bootstrapSchema(db, [...REGISTRY_INDEX_SPECS, ...EVIDENCE_INDEX_SPECS]);
  v1 = await version("owner-a", "sample", "repo-a");
  otherVersion = await version("owner-a", "secondary", "repo-b");
  await version("owner-b", "sample", "repo-a");
  service = createEvidenceService(db);
});
afterAll(async () => { if (db) { try { await db.dropGraph(); } finally { await db.close(); } } });

describe("durable calls, events and replay", () => {
  it.each([false, true])("admits only one executor across two gateway cores (different content: %s)", async (differentContent) => {
    const ctx = context(["user"]);
    const target = await call(ctx);
    const secondDb = await GraphClient.connect({ url, graph });
    try {
      const stores = [createEvidenceService(db), createEvidenceService(secondDb)];
      let releaseReads!: () => void;
      const readsReady = new Promise<void>((resolve) => { releaseReads = resolve; });
      let initialReads = 0;
      let executions = 0;
      const cores = stores.map((store, index) => {
        const recorder: CallRecorder = { ...store.recorder,
          async findIdempotent(...args) {
            const previous = await store.recorder.findIdempotent(...args);
            if (initialReads < 2) {
              expect(previous).toBeNull();
              initialReads += 1;
              if (initialReads === 2) releaseReads();
              await readsReady;
            }
            return previous;
          },
        };
        return createGatewayCore({ db: index === 0 ? db : secondDb, recorder, handlers: {
          async report_feedback(handlerCtx, input) {
            executions += 1;
            return store.handlers.report_feedback!(handlerCtx, input);
          },
        } });
      });
      const request = { application: "flywheel", tool: "report_feedback", idempotency_key: "two-core-race",
        args: { call_refs: [target], signal: "negative", text: "one durable logical feedback" } };
      const requests = [request, differentContent ? { ...request, args: { ...request.args, signal: "positive" } } : request];
      const results = await Promise.allSettled(cores.map((core, index) => core.dispatch(ctx, requests[index]!)));
      expect(initialReads).toBe(2);
      expect(executions).toBe(1);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ shape: { code: differentContent ? "idempotency_conflict" : "outcome_unknown" } });
      if (!differentContent) expect(rejected[0]?.reason).toMatchObject({ shape: { outcome_certainty: "unknown" } });
      const winner = fulfilled[0]!;
      expect(winner.value.outcome).toBe("success");
      expect(await getCall(db, ctx.principal.owner_id, winner.value.call_ref)).toMatchObject({ outcome: "success" });
      const winnerIndex = results.findIndex((r) => r.status === "fulfilled");
      const replay = await cores[1]!.dispatch(ctx, requests[winnerIndex]!);
      expect(replay).toMatchObject({ call_ref: winner.value.call_ref, outcome: "success", result: winner.value.result });
      expect(executions).toBe(1);
    } finally { await secondDb.close(); }
  });

  it("persists unknown admission and completion separately, then replays after reconnect", async () => {
    const ctx = context();
    const a = admission(ctx, v1, { text: "actual input" }, "durable-replay");
    const first = await service.recorder.admit(a);
    expect(await getCall(db, "owner-a", first.call_id)).toMatchObject({ outcome: "unknown", duration_ms: null, output_ref: null });
    await expect(service.recorder.admit(a)).rejects.toMatchObject({ shape: { code: "outcome_unknown", outcome_certainty: "unknown" } });
    expect((await service.recorder.findIdempotent(ctx.principal, "sample", "word_count", "durable-replay"))?.call.call_id).toBe(first.call_id);
    await expect(service.recorder.admit({ ...a, args: { text: "different" } })).rejects.toMatchObject({ shape: { code: "idempotency_conflict" } });
    const completion = { outcome: "success" as const, result: { count: 2 }, error: null, duration_ms: 3 };
    await service.recorder.complete(first.call_id, completion);
    await service.recorder.complete(first.call_id, completion);
    await expect(service.recorder.complete(first.call_id, { ...completion, result: { count: 3 } })).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
    const reopened = await GraphClient.connect({ url, graph });
    try {
      const replay = await createEvidenceService(reopened).recorder.findIdempotent(ctx.principal, "sample", "word_count", "durable-replay");
      expect(replay).toMatchObject({ call: { call_id: first.call_id, outcome: "success", resolved_version: v1.version_id }, args_digest: canonicalDigest(a.args), result: { count: 2 } });
      expect(await createEvidenceService(reopened).recorder.findIdempotent({ ...ctx.principal, grant_id: newId("grant") }, "sample", "word_count", "durable-replay")).toBeNull();
    } finally { await reopened.close(); }
  });

  it("deduplicates event IDs independently and rejects different event content or ownership", async () => {
    const ctx = context();
    const id = await call(ctx);
    const event = { event_id: newId("event"), call_id: id, kind: "admission" as const, at: new Date().toISOString(), content_digest: canonicalDigest({ source: "receipt" }) };
    expect(await appendCallEvent(db, "owner-a", event)).toEqual(event);
    expect(await appendCallEvent(db, "owner-a", event)).toEqual(event);
    await expect(appendCallEvent(db, "owner-a", { ...event, content_digest: canonicalDigest({ source: "changed" }) })).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
    await expect(appendCallEvent(db, "owner-b", event)).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
  });

  it("retains sanitation metadata and refuses to replay a truncated or redacted original result", async () => {
    const ctx = context();
    const a = admission(ctx, v1, { authorization: "private", text: "Bearer private-token person@example.org" }, "redacted");
    const { call_id } = await service.recorder.admit(a);
    await service.recorder.complete(call_id, { outcome: "success", result: { text: "🌊".repeat(10_000) }, error: null, duration_ms: 1 });
    const stored = (await getCall(db, "owner-a", call_id))!;
    const input = (await getEvidence(db, "owner-a", stored.input_ref!))!;
    const output = (await getEvidence(db, "owner-a", stored.output_ref!))!;
    expect(input.redacted_paths).toEqual(["/authorization", "/text"]);
    expect(input.content_json).not.toContain("private");
    expect(output.truncated).toBe(true);
    expect(Buffer.byteLength(output.content_json)).toBeLessThanOrEqual(16_384);
    expect(stored.completeness.status).toBe("partial");
    expect((await service.recorder.findIdempotent(ctx.principal, "sample", "word_count", "redacted"))?.result).toBeUndefined();
  });
});

describe("append-only feedback and frozen server packets", () => {
  it("ACKs persisted feedback once, conflicts on different content, and stores no embedded secret", async () => {
    const ctx = context(["user"]);
    const id = await call(ctx);
    const input = { call_refs: [id], signal: "negative" as const, observed: "got 1", expected: "want 2", text: "password=private-value person@example.org", idempotency_key: "feedback-replay" };
    const first = await service.handlers.report_feedback!(ctx, input);
    expect(first.durable).toBe(true);
    expect(await service.handlers.report_feedback!(ctx, input)).toEqual(first);
    await expect(service.handlers.report_feedback!(ctx, { ...input, expected: "want 3" })).rejects.toMatchObject({ shape: { code: "idempotency_conflict" } });
    const record = await getRecord(db, "owner-a", first.feedback_id);
    expect(record?.record).toMatchObject({ call_refs: [id], expected: "want 2", source: "explicit" });
    const body = await getEvidence(db, "owner-a", String(record?.record["text_ref"]));
    expect(body?.content_json).not.toContain("private-value");
    expect(body?.content_json).not.toContain("person@example.org");
    await expect(read(ctx, [id])).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(service.handlers.report_feedback!(ctx, { call_refs: [id], signal: "mixed", text: "a".repeat(4001) })).rejects.toThrow();
  });

  it("freezes exact snapshots/digest, returns metadata to management, and preserves successors", async () => {
    const ctx = context();
    const id = await call(ctx);
    const feedback = await service.handlers.report_feedback!(ctx, { call_refs: [id], signal: "negative", observed: "count 1", expected: "count 2" });
    const missing = newId("call");
    const input = { call_refs: [missing, id], feedback_ids: [feedback.feedback_id], change_summary: "Fix the deterministic token counting defect" };
    const ack = await service.handlers.create_packet!(ctx, input);
    expect(Object.keys(ack).sort()).toEqual(["digest", "missing_refs", "packet_id"]);
    expect(ack.missing_refs).toContain(missing);
    expect(await service.handlers.create_packet!(ctx, { ...input, call_refs: [id, missing] })).toEqual(ack);
    const packet = (await getPacket(db, "owner-a", ack.packet_id))!;
    expect(packet.digest).toBe(canonicalDigest(packet, PACKET_DIGEST_EXCLUDED));
    expect(packet.source).toEqual(v1.source);
    expect(packet.reproduction).toEqual({ tool: "word_count", args: { text: "two words" } });
    expect(packet.expected_outcome).toBe("count 2");
    expect(packet.snapshot.calls[0]?.["call_id"]).toBe(id);
    const successor = await service.handlers.create_packet!(ctx, { ...input, successor_of: ack.packet_id, change_summary: "Constrain the fix to whitespace handling" });
    expect((await getPacket(db, "owner-a", successor.packet_id))?.successor_of).toBe(ack.packet_id);
    expect(await getPacket(db, "owner-a", ack.packet_id)).toEqual(packet);
    const management = context(["management"]);
    await expect(read(management, [ack.packet_id])).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(service.handlers.create_packet!(context(["development"]), input)).rejects.toMatchObject({ shape: { code: "forbidden" } });
  });

  it("marks missing completion/body and never manufactures a reproduction from redacted input", async () => {
    const ctx = context();
    const { call_id } = await service.recorder.admit(admission(ctx, v1, { token: "secret" }));
    const feedback = await service.handlers.report_feedback!(ctx, { call_refs: [call_id], signal: "mixed" });
    const ack = await service.handlers.create_packet!(ctx, { call_refs: [call_id], feedback_ids: [feedback.feedback_id], change_summary: "Investigate missing completion" });
    const packet = (await getPacket(db, "owner-a", ack.packet_id))!;
    expect(packet.reproduction).toBeNull();
    expect(packet.completeness.status).toBe("partial");
    expect(ack.missing_refs).toEqual(expect.arrayContaining([`${call_id}:completion`, `${call_id}:output`, `${feedback.feedback_id}:text`]));
    expect(packet.snapshot.calls[0]?.["outcome"]).toBe("unknown");
    await service.recorder.complete(call_id, { outcome: "success", result: { count: 2 }, error: null, duration_ms: 7 });
    expect((await getCall(db, "owner-a", call_id))?.outcome).toBe("success");
    expect(await getPacket(db, "owner-a", ack.packet_id)).toEqual(packet);
  });
});

describe("authorized reads, graph context and bounded cursors", () => {
  it("makes cross-owner/app/repo refs indistinguishable from missing, and rejects identity mismatch", async () => {
    const owner = context();
    const own = await call(owner);
    const foreign = await call(owner, undefined, otherVersion);
    const other = context(["development"], "owner-b");
    expect((await read(other, [own, newId("call")])).items).toEqual([]);
    const appLimited = context(["development"], "owner-a", ["sample"]);
    expect((await read(appLimited, [foreign])).missing_refs).toEqual([foreign]);
    const repoLimited = context(["development"]); repoLimited.grant.allow.repos = ["repo-b"];
    expect((await read(repoLimited, [own])).missing_refs).toEqual([own]);
    const mismatch = context(["development"]); mismatch.principal.owner_id = "owner-b";
    await expect(read(mismatch, [own])).rejects.toMatchObject({ shape: { code: "not_found" } });
    const user = context(["user"]);
    await expect(service.handlers.report_feedback!(user, { call_refs: [foreign], signal: "negative" })).resolves.toHaveProperty("durable", true);
    user.grant.allow.apps = ["sample"];
    await expect(service.handlers.report_feedback!(user, { call_refs: [foreign], signal: "negative" })).rejects.toMatchObject({ shape: { code: "not_found" } });
  });

  it("blocks raw input refs from a denied tool even when app matches", async () => {
    const ctx = context(); const id = await call(ctx);
    const stored = (await getCall(db, "owner-a", id))!;
    const restricted = context(["development"]); restricted.grant.allow.tools["sample"] = ["different-tool"];
    expect((await read(restricted, [id, stored.input_ref!])).items).toEqual([]);
  });

  it("returns related actual resolved context and paginates deterministically with owner/query-bound cursors", async () => {
    const ctx = context(); const id = await call(ctx);
    const fb = await service.handlers.report_feedback!(ctx, { call_refs: [id], signal: "negative", expected: "count 2" });
    const pkt = await service.handlers.create_packet!(ctx, { call_refs: [id], feedback_ids: [fb.feedback_id], change_summary: "Fix count" });
    const input = { application: "sample", call_ref: id, limit: 1 };
    const seen = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 60; page++) {
      const response = GetContextOutput.parse(await service.handlers.get_context!(ctx, { ...input, ...(cursor ? { cursor } : {}) }));
      expect(response.completeness.notes.join(" ")).toContain(v1.version_id);
      for (const item of response.items) { expect(seen.has(item.ref)).toBe(false); seen.add(item.ref); }
      if (!response.next_cursor) break;
      if (!cursor) {
        const hidden = await service.handlers.get_context!(context(["development"], "owner-b"), { ...input, cursor: response.next_cursor });
        expect(hidden.items).toEqual([]);
        expect(hidden.completeness.missing_refs).toEqual([id]);
        await expect(service.handlers.get_context!(context(["development"]), { ...input, cursor: response.next_cursor })).rejects.toMatchObject({ shape: { code: "invalid_args" } });
      }
      cursor = response.next_cursor;
    }
    expect(seen.has(id)).toBe(true); expect(seen.has(fb.feedback_id)).toBe(true); expect(seen.has(pkt.packet_id)).toBe(true);
    const all = await service.handlers.get_context!(ctx, { application: "sample", call_ref: id, limit: 50 });
    expect(all.lineage).toContainEqual({ from: fb.feedback_id, rel: "ABOUT", to: id });
    const refs = [id, fb.feedback_id, pkt.packet_id].sort();
    const first = GetEvidenceOutput.parse(await service.handlers.get_evidence!(ctx, { refs, limit: 1 }));
    expect(first.items).toHaveLength(1); expect(first.next_cursor).not.toBeNull();
    expect(first.next_cursor!.length).toBeLessThanOrEqual(200);
    const second = await service.handlers.get_evidence!(ctx, { refs, limit: 1, cursor: first.next_cursor! });
    expect(second.items[0]?.ref).not.toBe(first.items[0]?.ref);
    const revoked = { ...ctx, grant: { ...ctx.grant, revoked_at: new Date().toISOString() } };
    await expect(read(revoked, refs)).rejects.toMatchObject({ shape: { code: "forbidden" } });
  });

  it("denies forged job scopes without a real job-to-packet relationship", async () => {
    const ctx = context(); const id = await call(ctx);
    const ack = await service.handlers.create_packet!(ctx, { call_refs: [id], feedback_ids: [], change_summary: "Fix" });
    const scoped = context(["development"]); scoped.grant.scope = { job_id: newId("job"), packet_id: ack.packet_id };
    const result = await read(scoped, [ack.packet_id, id]);
    expect(result.items).toEqual([]); expect(result.missing_refs.sort()).toEqual([ack.packet_id, id].sort());
  });

  it("restricts packet scopes to exact frozen refs and forbids management through a coding scope", async () => {
    const ctx = context(); const own = await call(ctx); const unrelated = await call(ctx);
    const packet = await service.handlers.create_packet!(ctx, { call_refs: [own], feedback_ids: [], change_summary: "Fix" });
    const scoped = context(["development", "management"]); scoped.grant.scope = { packet_id: packet.packet_id };
    const result = await read(scoped, [own, unrelated, packet.packet_id]);
    expect(result.items.map((r) => r.ref).sort()).toEqual([own, packet.packet_id].sort());
    expect(result.missing_refs).toEqual([unrelated]);
    await expect(service.handlers.create_packet!(scoped, { call_refs: [own], feedback_ids: [], change_summary: "No" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect((await getPacket(db, "owner-b", packet.packet_id))).toBeNull();
  });

  it("never ACKs or returns empty evidence on a closed persistent store", async () => {
    const closed = await GraphClient.connect({ url, graph }); await closed.close();
    const unavailable = createEvidenceService(closed); const ctx = context(); const id = await call(ctx);
    await expect(unavailable.handlers.report_feedback!(ctx, { call_refs: [id], signal: "negative" })).rejects.toMatchObject({ shape: { code: "storage_unavailable" } });
    await expect(unavailable.handlers.get_evidence!(ctx, { refs: [id] })).rejects.toMatchObject({ shape: { code: "storage_unavailable" } });
    await expect(unavailable.recorder.complete(id, { outcome: "success", result: {}, error: null, duration_ms: 1 })).rejects.toMatchObject({ shape: { code: "storage_unavailable" } });
  });

  it("preserves unknown completion when a write fails, and reconciles a timed-out committed feedback", async () => {
    const ctx = context();
    const { call_id } = await service.recorder.admit(admission(ctx));
    const completion = { outcome: "success" as const, result: { count: 2 }, error: null, duration_ms: 4 };
    await expect(createEvidenceService(uncertainWrites(false)).recorder.complete(call_id, completion)).rejects.toMatchObject({ shape: { code: "storage_unavailable", outcome_certainty: "unknown" } });
    expect(await getCall(db, "owner-a", call_id)).toMatchObject({ outcome: "unknown", output_ref: null, duration_ms: null });
    await expect(createEvidenceService(uncertainWrites(true)).recorder.complete(call_id, completion)).rejects.toMatchObject({ shape: { code: "storage_unavailable", outcome_certainty: "unknown" } });
    expect(await getCall(db, "owner-a", call_id)).toMatchObject({ outcome: "success", duration_ms: 4 });
    await service.recorder.complete(call_id, completion);
    const input = { call_refs: [call_id], signal: "negative" as const, text: "explicit feedback", idempotency_key: "uncertain-feedback" };
    await expect(createEvidenceService(uncertainWrites(true)).handlers.report_feedback!(ctx, input)).rejects.toMatchObject({ shape: { code: "storage_unavailable", outcome_certainty: "unknown" } });
    const receipt = await service.handlers.report_feedback!(ctx, input);
    expect(receipt.durable).toBe(true);
    expect((await getRecord(db, "owner-a", receipt.feedback_id))?.record["call_refs"]).toEqual([call_id]);
  });

  it("bounds oversized packet reads with explicit incompleteness and exact expansion refs", async () => {
    const ctx = context();
    const id = await call(ctx, { text: "x".repeat(16_000) });
    const feedback = await service.handlers.report_feedback!(ctx, { call_refs: [id], signal: "negative", text: "y".repeat(4000) });
    const ack = await service.handlers.create_packet!(ctx, { call_refs: [id], feedback_ids: [feedback.feedback_id], change_summary: "Fix" });
    const small = createEvidenceService(db, { maxResponseBytes: 24_576 });
    const response = await small.handlers.get_evidence!(ctx, { refs: [ack.packet_id] });
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(24_576);
    expect(response.items[0]?.record).toMatchObject({ truncated: true, completeness: { status: "partial" } });
    expect(response.items[0]?.record["evidence_refs"]).toEqual((await getPacket(db, "owner-a", ack.packet_id))?.evidence_refs);
  });

  it("treats cross-app packet evidence as missing even when the manager has both apps", async () => {
    const ctx = context();
    const own = await call(ctx); const other = await call(ctx, undefined, otherVersion);
    const foreignEvidence = (await getCall(db, "owner-a", other))!.input_ref!;
    const ack = await service.handlers.create_packet!(ctx, { call_refs: [own], feedback_ids: [], evidence_refs: [foreignEvidence], change_summary: "Fix same app" });
    const packet = (await getPacket(db, "owner-a", ack.packet_id))!;
    expect(packet.missing_refs).toContain(foreignEvidence);
    expect(packet.evidence_refs).not.toContain(foreignEvidence);
    expect(packet.snapshot.evidence.some((e) => e["evidence_id"] === foreignEvidence)).toBe(false);
  });
});
