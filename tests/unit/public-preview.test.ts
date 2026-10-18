import { beforeEach, expect, it, vi } from "vitest";
import { canonicalDigest, COMPLETE, type Version } from "../../src/contracts.js";
import { enrollPublicPreview, PublicPreviewEnrollment, verifyPublicPreview } from "../../src/cli/public-preview.js";
import { assertVersionReady, getApplication, getVersion, insertVersion, insertApplication, versionDigest } from "../../src/db/registry.js";
import { readUpstreamCatalog } from "../../src/gateway/upstream.js";
import type { GraphClient } from "../../src/db/client.js";
vi.mock("../../src/db/registry.js", async (original) => ({ ...await original<typeof import("../../src/db/registry.js")>(), getApplication: vi.fn(), getVersion: vi.fn(), insertVersion: vi.fn(), insertApplication: vi.fn() }));
vi.mock("../../src/gateway/upstream.js", async (original) => ({ ...await original<typeof import("../../src/gateway/upstream.js")>(), readUpstreamCatalog: vi.fn() }));
const input = { application: "sample", description: "Sample application", label: "preview-2", source: { repo_id: "sample/demo", commit_sha: "b".repeat(40) },
  url: "https://sample-unique.vercel.app/mcp", deployment_id: "dpl_unique", project_id: "prj_example", team_id: "team_example",
  parent_version_id: "ver_00000000000000000000000001", tools: ["count"], auth_mode: "none" as const, network_policy: "public_ipv4_pinned" as const };
const tool = { name: "count", description: "Counts words", input_schema: { type: "object", properties: {} }, effects: { read_only: true, destructive: false, idempotent: true, open_world: false } };
const owner = { owner_id: "owner", subject: "trusted-owner" };
const body = { schema_version: 1 as const, owner_id: owner.owner_id, created_at: "2026-01-01T00:00:00Z", provenance: { recorded_by: "owner_cli" as const, subject: owner.subject, grant_id: null, client_id: null, session_id: null }, completeness: COMPLETE,
  application: input.application, label: "v1", version_id: input.parent_version_id, parent_version_id: null, source: { ...input.source, commit_sha: "a".repeat(40) }, tools: [tool], schema_digest: canonicalDigest({ tools: [tool] }),
  runtime_target: { kind: "mcp_streamable_http" as const, url: "http://127.0.0.1:9090/mcp", deployment_id: "local", environment: "local" as const }, auth_config_ref: null,
  verified_provenance: { method: "owner_config" as const, job_id: null, packet_id: null }, state: "ready" as const,
  readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
let parent: Version;
let deployment: Record<string, unknown>;
let project: Record<string, unknown>;
let saved: Version | undefined;
const provider = { read: vi.fn(async (route: string) => route.startsWith("/v13/") ? deployment : project) };
const db = { query: vi.fn(), roQuery: vi.fn() } as unknown as GraphClient;
beforeEach(() => {
  vi.clearAllMocks(); saved = undefined; parent = { ...body, digest: versionDigest(body) };
  deployment = { id: input.deployment_id, url: "sample-unique.vercel.app", projectId: input.project_id, team: { id: input.team_id }, target: null, readyState: "READY",
    gitSource: { type: "github", repoId: 12345, sha: input.source.commit_sha }, meta: { githubCommitSha: input.source.commit_sha, githubCommitOrg: "sample", githubCommitRepo: "demo" } };
  project = { id: input.project_id, accountId: input.team_id, link: { type: "github", org: "sample", repo: "demo", repoId: 12345 } };
  vi.mocked(getVersion).mockImplementation(async (_db, _owner, _app, id) => id === input.parent_version_id ? parent : saved ?? null);
  vi.mocked(getApplication).mockResolvedValue({ ...body, description: input.description, kind: "upstream" });
  vi.mocked(readUpstreamCatalog).mockResolvedValue([tool, { ...tool, name: "excluded" }]);
  vi.mocked(insertVersion).mockImplementation(async (_db, version) => { saved = version; return version; });
});

it("registers selected actual catalog under the same app without claiming authenticated access or a managed job", async () => {
  const result = await enrollPublicPreview(db, owner, input, provider);
  expect(result.stable_changed).toBe(false);
  expect(saved).toMatchObject({ application: input.application, parent_version_id: input.parent_version_id, auth_config_ref: null,
    public_access: { mode: "public", provider: "vercel", source_verification: "provider_git" },
    verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, readiness: { auth_verified: false } });
  expect(saved!.tools).toEqual([tool]); expect(() => assertVersionReady(saved!)).not.toThrow();
  expect(readUpstreamCatalog).toHaveBeenCalledWith(expect.objectContaining({ auth_config_ref: null, public_access: expect.objectContaining({ mode: "public" }) }), {});
  expect(insertApplication).not.toHaveBeenCalled(); expect(db.query).not.toHaveBeenCalled();
});
it("records owner-upload metadata honestly and rejects mismatched provider claims", async () => {
  deployment.gitSource = null; deployment.meta = { tooltunerRepoId: input.source.repo_id, tooltunerCommitSha: input.source.commit_sha };
  expect((await verifyPublicPreview(PublicPreviewEnrollment.parse(input), provider)).source_verification).toBe("owner_metadata");
  deployment.gitSource = { type: "github", repoId: 12345, sha: "c".repeat(40) };
  await expect(verifyPublicPreview(PublicPreviewEnrollment.parse(input), provider)).rejects.toThrow(/source metadata/);
});
it.each([
  { id: "dpl_other" }, { projectId: "prj_other" }, { team: { id: "team_other" } }, { ownerId: "team_other" },
  { target: "production" }, { customEnvironment: { id: "custom" } }, { readyState: "BUILDING" },
  { url: "localhost" }, { url: "sample.vercel.app.evil.example" }, { url: "127.0.0.1" },
  { meta: {} }, { gitSource: { type: "github", repoId: 12345, sha: "c".repeat(40) } },
  { gitSource: { type: "github", repoId: 98765, sha: input.source.commit_sha } },
])("rejects wrong provider evidence before catalog or writes: %j", async (change) => {
  Object.assign(deployment, change);
  await expect(enrollPublicPreview(db, owner, input, provider)).rejects.toThrow();
  expect(readUpstreamCatalog).not.toHaveBeenCalled(); expect(insertVersion).not.toHaveBeenCalled();
});
it.each([
  "http://sample-unique.vercel.app/mcp", "https://sample-branch.vercel.app/mcp", "https://127.0.0.1/mcp", "https://sample-unique.vercel.app:8443/mcp",
  "https://user:password@sample-unique.vercel.app/mcp", "https://sample-unique.vercel.app/mcp?token=secret", "https://sample-unique.vercel.app/mcp#fragment",
])("rejects alternate or unsafe URL %s", async (url) => {
  await expect(enrollPublicPreview(db, owner, { ...input, url }, provider)).rejects.toThrow();
  expect(readUpstreamCatalog).not.toHaveBeenCalled();
});
it.each([{ owner_id: "other" }, { application: "other" }, { version_id: "ver_00000000000000000000000002" }, { source: { repo_id: "other/repo", commit_sha: "a".repeat(40) } }])("rejects foreign parent before provider reads: %j", async (change) => {
  Object.assign(parent, change); await expect(enrollPublicPreview(db, owner, input, provider)).rejects.toThrow(/exact parent/); expect(provider.read).not.toHaveBeenCalled();
});
it("requires explicit public consent and capabilities; never silently converts protected input", async () => {
  for (const change of [{ auth_mode: undefined }, { network_policy: undefined }, { network_policy: "fallback" }, { auth_mode: "oauth" }, { auth_config_ref: "oauth:secret" }, { tools: [] }, { parent_version_id: null }]) {
    await expect(enrollPublicPreview(db, owner, { ...input, ...change }, provider)).rejects.toThrow();
  }
  expect(provider.read).not.toHaveBeenCalled();
});
it("fails catalog mismatch without creating a version", async () => {
  await expect(enrollPublicPreview(db, owner, { ...input, tools: ["absent"] }, provider)).rejects.toThrow(/selected tool/); expect(insertVersion).not.toHaveBeenCalled();
});
it("binds public policy in the digest and leaves all existing digests/readiness semantics intact", async () => {
  expect(versionDigest(parent)).toBe(parent.digest);
  await enrollPublicPreview(db, owner, input, provider);
  expect(versionDigest({ ...saved!, public_access: undefined })).not.toBe(saved!.digest);
  expect(() => assertVersionReady({ ...saved!, public_access: undefined })).toThrow();
  expect(() => assertVersionReady({ ...saved!, auth_config_ref: "oauth:protected" })).toThrow();
  expect(() => assertVersionReady({ ...saved!, readiness: { ...saved!.readiness, auth_verified: true } })).toThrow();
  expect(() => assertVersionReady(parent)).not.toThrow();
  expect(() => assertVersionReady({ ...parent, readiness: { ...parent.readiness, auth_verified: false } })).toThrow();
});
