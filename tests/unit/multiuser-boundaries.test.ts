import { describe, expect, it, vi } from "vitest";
import { Application, Call, COMPLETE, Grant, Version, canonicalDigest, canonicalJson, newId, provenanceOf, type OperationContext } from "../../src/contracts.js";
import type { GraphClient, QueryParams } from "../../src/db/client.js";
import { admissionKey, getPacket } from "../../src/db/evidence.js";
import { getCredentialBinding, getUpstreamAccount, versionDigest } from "../../src/db/registry.js";
import { createGatewayCore } from "../../src/gateway/core.js";
import { createEvidenceService } from "../../src/flywheel/evidence.js";
import { createJobService } from "../../src/flywheel/jobs.js";
import { activateVersion } from "../../src/cli/versions.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const EMPTY = "33333333-3333-4333-8333-333333333333";
const at = "2026-01-01T00:00:00.000Z";
function context(owner: string): OperationContext {
  const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: owner, label: "Synthetic test grant",
    groups: ["user", "development", "management"], allow: { apps: ["*"], repos: ["fixture"], tools: {} }, created_at: at });
  return { grant, principal: { owner_id: owner, grant_id: grant.grant_id, subject: owner, client_id: "test", session_id: null }, call_id: newId("call") };
}

/** A deliberately small synthetic graph, not a Cypher engine. Unknown queries fail closed.
 * Real gateway, handlers and repository functions run unchanged. Every supported read
 * requires its real query text to carry the tenant predicate, not just a test-side filter.
 */
function fixture() {
  const contexts = [context(A), context(B)];
  const apps = contexts.map(({ principal }) => Application.parse({ schema_version: 1, owner_id: principal.owner_id,
    created_at: at, provenance: provenanceOf("seed", null), completeness: COMPLETE,
    application: "sample", description: `Catalog for ${principal.owner_id}`, kind: "upstream" }));
  const versions = apps.map((app) => {
    const content = { ...app, version_id: newId("version"), label: "v1", parent_version_id: null,
      source: { repo_id: "fixture", commit_sha: "a".repeat(40) }, tools: [{ name: "echo", description: "Synthetic tool",
        input_schema: { type: "object" }, effects: { read_only: true, destructive: false, idempotent: true, open_world: false } }],
      runtime_target: { kind: "mcp_streamable_http" as const, url: "https://example.invalid/mcp", environment: "production" as const, deployment_id: null },
      auth_config_ref: null, verified_provenance: { method: "owner_config" as const, job_id: null, packet_id: null }, state: "ready" as const,
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
    const body = { ...content, schema_digest: canonicalDigest({ tools: content.tools }) };
    return Version.parse({ ...body, digest: versionDigest(body) });
  });
  const calls = contexts.map(({ principal }, i) => Call.parse({ schema_version: 1, owner_id: principal.owner_id, created_at: at,
    provenance: provenanceOf("gateway", principal), completeness: COMPLETE, call_id: newId("call"), subject: principal.subject,
    session_id: null, run_id: null, client_id: principal.client_id, grant_id: principal.grant_id, application: "sample", tool: "echo",
    requested_version: null, resolved_version: versions[i]!.version_id, schema_digest: versions[i]!.schema_digest,
    idempotency_key: null, input_ref: null, output_ref: null, causal_refs: [], outcome: "success", error: null, duration_ms: 1 }));
  const foreignJob = newId("job"), foreignPacket = newId("packet"), foreignEvidence = newId("evidence"), foreignFeedback = newId("feedback");
  const records = [...calls.map((call) => ({ ref: call.call_id, kind: "Call", record: call })),
    ...[[foreignPacket, "Packet"], [foreignEvidence, "Evidence"], [foreignFeedback, "Feedback"]].map(([ref, kind]) => ({ ref: ref!, kind: kind!, record: { owner_id: B } }))];
  const row = (doc: unknown) => ({ doc: canonicalJson(doc) });
  const roQuery = vi.fn(async (query: string, p: QueryParams = {}) => {
    if (query.includes("HumanDecision")) return [];
    if (query.includes("UpstreamAccount") || query.includes("UpstreamCredentialBinding")) {
      expect(query).toContain("registry_key:$key");
      expect(JSON.parse(String(p.key))[0]).toBe(A);
      return [];
    }
    if (query.includes("(a:Application")) {
      if (query.includes("owner_id: $owner")) return apps.filter((a) => a.owner_id === p.owner).map(row);
      expect(query).toContain("registry_key: $key");
      const [owner, application] = JSON.parse(String(p.key)) as string[];
      const app = apps.find((a) => a.owner_id === owner && a.application === application);
      if (!app) return [];
      if (query.includes("HAS_VERSION")) {
        expect(query).toContain("v.owner_id = $owner");
        return versions.filter((v) => v.owner_id === p.owner && (v.version_id === p.selector || v.label === p.selector)).map(row);
      }
      if (query.includes("stable_doc")) return [row({ application, version_id: versions.find((v) => v.owner_id === owner)!.version_id, decision_id: null, updated_at: at })];
      return [row(app)];
    }
    if (query.includes("(j:Job")) {
      expect(query).toContain("owner_id: $owner");
      expect(p.owner).toBe(A);
      // The foreign job exists, but this owner's lookup must be indistinguishable from absent.
      return [];
    }
    if (query.includes("MATCH (n) WHERE")) {
      expect(query).toMatch(/n\.owner_id\s*=\s*\$owner/);
      const requested = (p.requested ?? [p.ref]) as string[];
      return records.filter((r) => r.record.owner_id === p.owner && requested.includes(r.ref))
        .map((r) => ({ ref: r.ref, kind: r.kind, ...row(r.record) }));
    }
    throw new Error(`Unsupported synthetic read: ${query}`);
  });
  const query = vi.fn(async () => { throw new Error("This isolation scenario must not write"); });
  const db = { roQuery, query } as unknown as GraphClient;
  const recorder = { admit: vi.fn(), complete: vi.fn(), findIdempotent: vi.fn() };
  const evidence = createEvidenceService(db);
  const runner = { launch: vi.fn(), reconcile: vi.fn(), verifyArtifact: vi.fn() };
  const registerPreview = vi.fn();
  const jobs = createJobService({ db, repositories: [], runnerConfigs: [], runner, registerPreview, getPacket });
  const core = createGatewayCore({ db, recorder, handlers: { ...evidence.handlers, ...jobs } });
  return { db, roQuery, query, recorder, evidence, jobs, core, runner, registerPreview, contexts, versions, calls,
    foreignJob, foreignPacket, foreignEvidence, foreignFeedback };
}
const missing = { shape: { code: "not_found" } };

describe("synthetic multi-user graph boundary integration (no database or upstream)", () => {
  it("keeps same-name catalogs and STABLE pointers separate for two UUID owners", async () => {
    const f = fixture();
    for (const [i, ctx] of f.contexts.entries()) {
      const catalog = await f.core.listApps(ctx);
      expect(catalog.apps.find((a) => a.application === "sample")?.stable_version).toBe(f.versions[i]!.version_id);
      expect((await f.core.describe(ctx, { application: "sample" })).resolved_version).toBe(f.versions[i]!.version_id);
      await expect(f.core.describe(ctx, { application: "sample", version: f.versions[1 - i]!.version_id }))
        .rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    }
    expect((await f.core.listApps(context(EMPTY))).apps.filter((a) => a.application !== "flywheel")).toEqual([]);
  });

  it("rejects foreign version dispatch and caller owner overrides before admission", async () => {
    const f = fixture(), ctx = f.contexts[0]!;
    await expect(f.core.dispatch(ctx, { application: "sample", version: f.versions[1]!.version_id, tool: "echo", args: {} }))
      .rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    const forgedDescription = { application: "sample", owner_id: B };
    const forgedDispatch = { application: "sample", tool: "echo", owner_id: B, args: {} };
    await expect(f.core.describe(ctx, forgedDescription)).rejects.toMatchObject({ shape: { code: "invalid_args" } });
    await expect(f.core.dispatch(ctx, forgedDispatch)).rejects.toMatchObject({ shape: { code: "invalid_args" } });
    await expect(f.core.dispatch(ctx, { application: "flywheel", tool: "get_evidence", args: { refs: [f.calls[1]!.call_id], owner_id: B } }))
      .rejects.toMatchObject({ shape: { code: "invalid_args" } });
    expect(f.recorder.admit).not.toHaveBeenCalled();
  });

  it("hides foreign traces, evidence, feedback and packets while allowing an own trace", async () => {
    const f = fixture(), ctx = f.contexts[0]!, foreign = f.calls[1]!.call_id;
    const refs = [f.calls[0]!.call_id, foreign, f.foreignEvidence, f.foreignFeedback, f.foreignPacket];
    const read = await f.evidence.handlers.get_evidence!(ctx, { refs });
    expect(read.items.map((i) => i.ref)).toEqual([f.calls[0]!.call_id]);
    expect(read.missing_refs.sort()).toEqual(refs.slice(1).sort());
    const trace = await f.evidence.handlers.get_context!(ctx, { application: "sample", call_ref: foreign });
    expect(trace.items).toEqual([]);
    expect(trace.completeness.missing_refs).toContain(foreign);
    await expect(f.evidence.handlers.report_feedback!(ctx, { call_refs: [foreign], signal: "negative" })).rejects.toMatchObject(missing);
    await expect(f.evidence.handlers.create_packet!(ctx, { call_refs: [foreign], feedback_ids: [], change_summary: "Synthetic change" })).rejects.toMatchObject(missing);
    await expect(f.evidence.handlers.report_feedback!(ctx, { call_refs: [f.calls[0]!.call_id], signal: "negative", evidence_refs: [f.foreignEvidence] })).rejects.toMatchObject(missing);
    expect(f.query).not.toHaveBeenCalled();
  });

  it("blocks foreign jobs and packets before launching, polling or reading artifact workspaces", async () => {
    const f = fixture(), ctx = f.contexts[0]!;
    await expect(f.jobs.get_job(ctx, { job_id: f.foreignJob })).rejects.toMatchObject(missing);
    await expect(f.jobs.start_job(ctx, { packet_id: f.foreignPacket, repo_id: "fixture", base_sha: "a".repeat(40),
      runner_config_id: "synthetic", idempotency_key: "test" })).rejects.toMatchObject(missing);
    await expect(f.jobs.register_preview(ctx, { job_id: f.foreignJob, application: "sample", parent_version: f.versions[1]!.version_id,
      artifact_ref: "foreign-artifact", deployment_ref: "foreign-deployment" })).rejects.toMatchObject(missing);
    for (const action of Object.values(f.runner)) expect(action).not.toHaveBeenCalled();
    expect(f.registerPreview).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });

  it("binds CLI activation to trusted owner context even when receipt input names another owner", async () => {
    const f = fixture();
    const input = { owner_id: B, application: "sample", selected_version_id: f.versions[1]!.version_id,
      expected_current_version_id: null, receipt: { synthetic: true } };
    await expect(activateVersion(f.db, { owner_id: A, subject: A }, input)).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expect(f.query).not.toHaveBeenCalled();
  });

  it("partitions account bindings and idempotency keys by authenticated owner", async () => {
    const f = fixture();
    expect(await getUpstreamAccount(f.db, A, "shared-reference")).toBeNull();
    expect(await getCredentialBinding(f.db, A, "shared-reference", "https://example.invalid/mcp")).toBeNull();
    expect(admissionKey(A, "grant", "sample", "echo", "same-key")).not.toBe(admissionKey(B, "grant", "sample", "echo", "same-key"));
  });
});
