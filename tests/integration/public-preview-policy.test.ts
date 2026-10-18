/** Synthetic public policy persistence only; no external provider or deployment is contacted. */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, insertApplication, insertVersion, getVersion, versionDigest, assertVersionReady } from "../../src/db/registry.js";
import { COMPLETE, canonicalDigest, newId, provenanceOf, type Version } from "../../src/contracts.js";
it("roundtrips public policy without claiming authenticated access and rejects policy tampering", async () => {
  if (!process.env.FALKORDB_URL) throw new Error("Set a disposable FALKORDB_URL explicitly");
  const db = await GraphClient.connect({ url: process.env.FALKORDB_URL, graph: `public_policy_${randomUUID().replaceAll("-", "")}` });
  try {
    await bootstrapSchema(db, REGISTRY_INDEX_SPECS);
    const metadata = { schema_version: 1 as const, owner_id: "synthetic-owner", created_at: new Date().toISOString(), provenance: provenanceOf("owner_cli", null), completeness: COMPLETE };
    await insertApplication(db, { ...metadata, application: "synthetic-app", description: "Synthetic persistence test", kind: "upstream" });
    const body: Omit<Version, "digest"> = { ...metadata, application: "synthetic-app", version_id: newId("version"), label: "public-test", parent_version_id: null,
      source: { repo_id: "synthetic/repository", commit_sha: "a".repeat(40) }, tools: [], schema_digest: canonicalDigest({ tools: [] }),
      runtime_target: { kind: "mcp_streamable_http", url: "https://synthetic-preview.vercel.app/mcp", deployment_id: "dpl_synthetic", environment: "preview" }, auth_config_ref: null,
      public_access: { mode: "public", provider: "vercel", project_id: "prj_synthetic", team_id: "team_synthetic", source_verification: "provider_git", network_policy: "provider_verified_vercel" },
      verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, state: "ready",
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: false } };
    const saved = await insertVersion(db, { ...body, digest: versionDigest(body) });
    const read = await getVersion(db, metadata.owner_id, body.application, saved.version_id);
    expect(read?.public_access).toEqual(body.public_access); expect(read?.readiness.auth_verified).toBe(false);
    expect(() => assertVersionReady(read!)).not.toThrow();
    expect(() => assertVersionReady({ ...read!, public_access: undefined })).toThrow();
    await expect(insertVersion(db, { ...read!, public_access: { ...read!.public_access!, network_policy: "public_ipv4_pinned" } })).rejects.toThrow(/digest/);
  } finally { try { await db.dropGraph(); } finally { await db.close(); } }
});
