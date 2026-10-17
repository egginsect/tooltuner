import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { Application, Job, Packet, Grant, COMPLETE, canonicalDigest, newId, provenanceOf, type Version } from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, getStable, getVersion, insertApplication, insertVersion, versionDigest, seedInitialStable } from "../../src/db/registry.js";
import { resolveVersion, createPreviewRegistry } from "../../src/gateway/registry.js";
import { activateVersion, rollbackVersion, recordMerge } from "../../src/cli/versions.js";

let db: GraphClient;
const owner = { owner_id: "owner", subject: "local-owner" };
const metadata = () => ({ schema_version: 1 as const, owner_id: owner.owner_id, created_at: new Date().toISOString(), provenance: provenanceOf("seed", null), completeness: COMPLETE });

function version(label: string, overrides: Partial<Version> = {}): Version {
  const content = { ...metadata(), version_id: newId("version"), application: "textkit", label, parent_version_id: null, source: { repo_id: "fixture", commit_sha: "a".repeat(40) },
    tools: [], schema_digest: canonicalDigest({ tools: [] }), runtime_target: { kind: "mcp_streamable_http" as const, url: `http://127.0.0.1:8790/${label}/mcp`, deployment_id: null, environment: "local" as const },
    auth_config_ref: null, verified_provenance: { method: "owner_config" as const, job_id: null, packet_id: null }, state: "ready" as const,
    readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true }, ...overrides };
  return { ...content, digest: versionDigest(content) };
}

beforeEach(async () => {
  db = await GraphClient.connect({ url: process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379", graph: `gateway_registry_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, REGISTRY_INDEX_SPECS);
  await insertApplication(db, Application.parse({ ...metadata(), application: "textkit", description: "Fixture", kind: "upstream" }));
});
afterEach(async () => { if (db) { try { await db.dropGraph(); } finally { await db.close(); } } });

describe("real persisted owner registry", () => {
  it("resolves stable and explicit ids/labels, never falls back, and survives reconnect", async () => {
    const v1 = await insertVersion(db, version("v1"));
    const v2 = await insertVersion(db, version("v2", { parent_version_id: v1.version_id }));
    await seedInitialStable(db, v1);
    expect((await resolveVersion(db, "owner", "textkit")).version_id).toBe(v1.version_id);
    expect((await resolveVersion(db, "owner", "textkit", "v2")).version_id).toBe(v2.version_id);
    expect((await resolveVersion(db, "owner", "textkit", v2.version_id)).version_id).toBe(v2.version_id);
    await expect(resolveVersion(db, "owner", "textkit", "missing")).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expect(await getVersion(db, "another-owner", "textkit", v1.version_id)).toBeNull();
    const reconnect = await GraphClient.connect({ url: process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379", graph: db.graphName });
    try { expect((await resolveVersion(reconnect, "owner", "textkit")).version_id).toBe(v1.version_id); }
    finally { await reconnect.close(); }
  });

  it("enforces immutable ids, owner/application labels and verified readiness", async () => {
    const v1 = await insertVersion(db, version("v1"));
    expect(await insertVersion(db, v1)).toEqual(v1);
    await expect(insertVersion(db, { ...v1, state: "unavailable" })).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
    await expect(insertVersion(db, version("v1"))).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
    await expect(insertVersion(db, { ...v1, schema_digest: canonicalDigest({ bad: true }) })).rejects.toMatchObject({ shape: { code: "invalid_args" } });
    await insertVersion(db, version("pending", { state: "pending_checks" }));
    await expect(resolveVersion(db, "owner", "textkit", "pending")).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    await expect(insertVersion(db, version("bad-parent", { parent_version_id: newId("version") }))).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    await expect(insertApplication(db, Application.parse({ ...metadata(), application: "flywheel", description: "Spoof", kind: "upstream" }))).rejects.toMatchObject({ shape: { code: "forbidden" } });
  });

  it("records merge independently, atomically activates with CAS, rolls back, and preserves history", async () => {
    const v1 = await insertVersion(db, version("v1"));
    const v2 = await insertVersion(db, version("v2", { parent_version_id: v1.version_id }));
    await seedInitialStable(db, v1);
    const merge = await recordMerge(db, owner, { application: "textkit", source: v2.source, selected_version_id: v2.version_id,
      expected_current_version_id: v1.version_id, receipt: { test_only: true, merge_receipt: "isolated graph" } });
    expect((await getStable(db, "owner", "textkit"))?.version_id).toBe(v1.version_id);
    const activation = await activateVersion(db, owner, { application: "textkit", selected_version_id: v2.version_id,
      expected_current_version_id: v1.version_id, receipt: { test_only: true } });
    expect(await getStable(db, "owner", "textkit")).toMatchObject({ version_id: v2.version_id, decision_id: activation.decision_id });
    await expect(activateVersion(db, owner, { application: "textkit", selected_version_id: v1.version_id,
      expected_current_version_id: v1.version_id, receipt: { test_only: true } })).rejects.toMatchObject({ shape: { code: "stale_expected_current" } });
    await rollbackVersion(db, owner, { application: "textkit", selected_version_id: v1.version_id,
      expected_current_version_id: v2.version_id, receipt: { test_only: true } });
    expect((await getStable(db, "owner", "textkit"))?.version_id).toBe(v1.version_id);
    const history = await db.roQuery<{ id: string }>("MATCH (d:HumanDecision {owner_id:$owner}) RETURN d.decision_id AS id", { owner: "owner" });
    expect(history.map((row) => row.id)).toContain(merge.decision_id);
    expect(history).toHaveLength(3);
    const stableEdges = await db.roQuery<{ n: number }>("MATCH (:Application {owner_id:$owner})-[s:STABLE]->(:Version) RETURN count(s) AS n", { owner: "owner" });
    expect(stableEdges[0]?.n).toBe(1);
  });

  it("allows only one concurrent decision from the same expected current", async () => {
    const v1 = await insertVersion(db, version("v1"));
    const v2 = await insertVersion(db, version("v2"));
    const v3 = await insertVersion(db, version("v3"));
    await seedInitialStable(db, v1);
    const decisions = await Promise.allSettled([v2, v3].map((v) => activateVersion(db, owner, { application: "textkit", selected_version_id: v.version_id,
      expected_current_version_id: v1.version_id, receipt: { test_only: true } })));
    expect(decisions.filter((d) => d.status === "fulfilled")).toHaveLength(1);
    expect(decisions.find((d) => d.status === "rejected")).toMatchObject({ reason: { shape: { code: "stale_expected_current" } } });
  });

  it("initializes an empty stable pointer by owner CAS and isolates equal application labels across owners", async () => {
    const v1 = await insertVersion(db, version("v1"));
    await activateVersion(db, owner, { application: "textkit", selected_version_id: v1.version_id, expected_current_version_id: null, receipt: { test_only: true } });
    await expect(activateVersion(db, owner, { application: "textkit", selected_version_id: v1.version_id, expected_current_version_id: null,
      receipt: { test_only: true } })).rejects.toMatchObject({ shape: { code: "stale_expected_current" } });
    await insertApplication(db, Application.parse({ ...metadata(), owner_id: "other-owner", application: "textkit", description: "Independent fixture", kind: "upstream" }));
    const other = await insertVersion(db, version("v1", { owner_id: "other-owner" }));
    await seedInitialStable(db, other);
    expect((await resolveVersion(db, "owner", "textkit")).version_id).toBe(v1.version_id);
    expect((await resolveVersion(db, "other-owner", "textkit")).version_id).toBe(other.version_id);
    expect(await getVersion(db, "owner", "textkit", other.version_id)).toBeNull();
  });

  it("binds a trusted preview receipt to owner, job, artifact and project without changing stable", async () => {
    const v1 = await insertVersion(db, version("v1"));
    await seedInitialStable(db, v1);
    const grant = Grant.parse({ schema_version: 1, owner_id: "owner", grant_id: newId("grant"), label: "test coordinator", groups: ["management"],
      allow: { apps: ["textkit"], repos: ["fixture"] }, created_at: new Date().toISOString() });
    const ctx = { principal: { owner_id: "owner", subject: "manager", grant_id: grant.grant_id, client_id: "test", session_id: null }, grant, call_id: newId("call") };
    const packet = Packet.parse({ ...metadata(), packet_id: newId("packet"), digest: canonicalDigest({ test_only: true }), application: "textkit", parent_version_id: v1.version_id,
      source: v1.source, call_refs: [], feedback_ids: [], evidence_refs: [], snapshot: { calls: [], feedback: [], evidence: [] }, capture_policy: "sanitized-bounded-v1",
      reproduction: null, expected_outcome: null, change_summary: "Isolated adapter boundary verification", successor_of: null, missing_refs: [] });
    const deployment = { deployment_id: "test-deployment", url: "https://exact-test-deployment.example/mcp", project_id: "test-project", commit_sha: "b".repeat(40), target: "preview", ready_at: new Date().toISOString() };
    const job = Job.parse({ ...metadata(), provenance: provenanceOf("manager", ctx.principal), job_id: newId("job"), application: "textkit", repo_id: "fixture", base_sha: v1.source.commit_sha,
      packet_id: packet.packet_id, runner_config_id: "test-only", submission_key: "test-only", state: "completed", external_receipt: null, workspace_ref: null,
      result: { branch: "test-only", commit_sha: deployment.commit_sha, artifact_ref: canonicalDigest({ test_only: "artifact" }), change_summary: "Adapter test only", checks: [], requested_deployment: null },
      deployment, version_id: null, error: null });
    const verification = { owner_id: "owner", application: "textkit", repo_id: "fixture", job_id: job.job_id, packet_id: packet.packet_id,
      artifact_digest: job.result!.artifact_ref, ...deployment, team_id: "test-team", tools: [], schema_digest: canonicalDigest({ tools: [] }),
      auth_config_ref: "test:credential-reference", checks: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
    const adapter = createPreviewRegistry({ db, projects: [{ owner_id: "owner", application: "textkit", repo_id: "fixture", project_id: "test-project", team_id: "test-team" }] });
    const result = await adapter.registerPreview(ctx, job, packet, verification);
    expect(result).toMatchObject({ state: "ready", missing_checks: [] });
    expect(await adapter.registerPreview(ctx, job, packet, verification)).toEqual(result);
    expect(await getVersion(db, "owner", "textkit", result.version_id)).toMatchObject({ parent_version_id: v1.version_id,
      verified_provenance: { method: "manager_verified", job_id: job.job_id, packet_id: packet.packet_id }, runtime_target: { deployment_id: deployment.deployment_id, environment: "preview" } });
    expect((await getStable(db, "owner", "textkit"))?.version_id).toBe(v1.version_id);
    await expect(adapter.registerPreview(ctx, job, packet, { ...verification, project_id: "wrong-project" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(adapter.registerPreview(ctx, job, packet, { ...verification, checks: { ...verification.checks, auth_verified: false } })).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    await expect(adapter.registerPreview(ctx, job, packet, { ...verification, url: "https://mutable-alias.example/mcp" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
  });
});
