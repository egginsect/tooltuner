import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { COMPLETE, Grant, Version, canonicalDigest, newId, provenanceOf, type OperationContext } from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { EVIDENCE_INDEX_SPECS, getCall } from "../../src/db/evidence.js";
import { REGISTRY_INDEX_SPECS, insertApplication, insertVersion, seedInitialStable, versionDigest,
  putUpstreamAccount, getUpstreamAccount, putCredentialBinding, getCredentialBinding, type UpstreamAccount, type CredentialBinding } from "../../src/db/registry.js";
import { createGatewayCore } from "../../src/gateway/core.js";
import { createEvidenceService } from "../../src/flywheel/evidence.js";

const owners = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const at = "2026-01-01T00:00:00.000Z";
const contexts: OperationContext[] = owners.map((owner) => {
  const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: owner, label: "Synthetic UUID integration",
    groups: ["user", "development", "management"], allow: { apps: ["sample"], repos: ["fixture"] }, created_at: at });
  return { grant, principal: { owner_id: owner, grant_id: grant.grant_id, subject: owner, client_id: "test", session_id: null }, call_id: newId("call") };
});
let db: GraphClient;
let service: ReturnType<typeof createEvidenceService>;
let core: ReturnType<typeof createGatewayCore>;
const versions: Version[] = [];
const calls: string[] = [];
beforeAll(async () => {
  // Explicit URL avoids accidentally using an existing default database.
  const url = process.env["FALKORDB_URL"];
  if (!url) throw new Error("Set FALKORDB_URL to an explicitly provisioned disposable database.");
  db = await GraphClient.connect({ url, graph: `uuid_boundary_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, [...REGISTRY_INDEX_SPECS, ...EVIDENCE_INDEX_SPECS]);
  service = createEvidenceService(db);
  core = createGatewayCore({ db, ...service });
  for (const ctx of contexts) {
    const base = { schema_version: 1 as const, owner_id: ctx.principal.owner_id, created_at: at, provenance: provenanceOf("seed", null), completeness: COMPLETE };
    await insertApplication(db, { ...base, application: "sample", description: `Synthetic catalog for ${base.owner_id}`, kind: "upstream" });
    const content = Version.parse({ ...base, version_id: newId("version"), digest: canonicalDigest({}), application: "sample", label: "v1", parent_version_id: null,
      source: { repo_id: "fixture", commit_sha: "a".repeat(40) }, tools: [], schema_digest: canonicalDigest({ tools: [] }),
      runtime_target: { kind: "mcp_streamable_http", url: "https://example.invalid/mcp", deployment_id: null, environment: "production" },
      auth_config_ref: null, verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, state: "ready",
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } });
    content.digest = versionDigest(content);
    versions.push(await insertVersion(db, content));
    await seedInitialStable(db, content);
    const call = await service.recorder.admit({ principal: ctx.principal, application: "sample", tool: "echo", requested_version: null,
      resolved_version: content.version_id, schema_digest: content.schema_digest, idempotency_key: "same-key", args: { message: "synthetic" }, causal_refs: [] });
    await service.recorder.complete(call.call_id, { outcome: "success", result: { synthetic: true }, error: null, duration_ms: 1 });
    calls.push(call.call_id);
  }
});
afterAll(async () => { if (db) { try { await db.dropGraph(); } finally { await db.close(); } } });

it("executes actual catalog and version Cypher with separate UUID-owned STABLE pointers", async () => {
  for (const [i, ctx] of contexts.entries()) {
    expect((await core.listApps(ctx)).apps.find((a) => a.application === "sample")?.stable_version).toBe(versions[i]!.version_id);
    expect((await core.describe(ctx, { application: "sample" })).resolved_version).toBe(versions[i]!.version_id);
    await expect(core.describe(ctx, { application: "sample", version: versions[1 - i]!.version_id }))
      .rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    await expect(core.dispatch(ctx, { application: "sample", version: versions[1 - i]!.version_id, tool: "echo", args: {} }))
      .rejects.toMatchObject({ shape: { code: "version_unavailable" } });
  }
});

it("executes actual trace and evidence Cypher without cross-owner records or feedback writes", async () => {
  expect(calls[0]).not.toBe(calls[1]);
  for (const [i, ctx] of contexts.entries()) {
    expect(await getCall(db, ctx.principal.owner_id, calls[1 - i]!)).toBeNull();
    const read = await service.handlers.get_evidence!(ctx, { refs: calls });
    expect(read.items.map((r) => r.ref)).toEqual([calls[i]]);
    expect(read.missing_refs).toEqual([calls[1 - i]]);
    const own = await service.handlers.get_context!(ctx, { application: "sample", call_ref: calls[i]! });
    expect(own.items.some((r) => r.ref === calls[i])).toBe(true);
    expect(own.items.some((r) => r.ref === calls[1 - i])).toBe(false);
    const foreign = await service.handlers.get_context!(ctx, { application: "sample", call_ref: calls[1 - i]! });
    expect(foreign.items).toEqual([]);
    await expect(service.handlers.report_feedback!(ctx, { call_refs: [calls[1 - i]!], signal: "negative" }))
      .rejects.toMatchObject({ shape: { code: "not_found" } });
    await expect(service.handlers.create_packet!(ctx, { call_refs: [calls[1 - i]!], feedback_ids: [], change_summary: "Synthetic" }))
      .rejects.toMatchObject({ shape: { code: "not_found" } });
  }
});

it("executes actual credential registry Cypher with identical references and distinct UUID ownership", async () => {
  for (const [i, owner] of owners.entries()) {
    const account: UpstreamAccount = { schema_version: 1, owner_id: owner, created_at: at, auth_config_ref: "shared-reference",
      credential_ref: `synthetic:owner-${i}`, application: "sample", repo_id: "fixture", environment: "production",
      issuer: "https://example.invalid", client_id: "synthetic-client", scopes: ["read"] };
    const binding: CredentialBinding = { schema_version: 1, owner_id: owner, created_at: at, auth_config_ref: "shared-reference", application: "sample",
      repo_id: "fixture", commit_sha: "a".repeat(40), deployment_id: `synthetic-${i}`, url: "https://example.invalid/mcp",
      resource: "https://example.invalid/mcp", audience: "synthetic", scopes: ["read"], environment: "production", issuer: "https://example.invalid" };
    await putUpstreamAccount(db, account);
    await putCredentialBinding(db, binding);
  }
  for (const [i, owner] of owners.entries()) {
    expect((await getUpstreamAccount(db, owner, "shared-reference"))?.credential_ref).toBe(`synthetic:owner-${i}`);
    expect((await getCredentialBinding(db, owner, "shared-reference", "https://example.invalid/mcp"))?.deployment_id).toBe(`synthetic-${i}`);
  }
});
