import { describe, expect, it, vi } from "vitest";
import { COMPLETE, Grant, Job, Packet, canonicalDigest, newId, provenanceOf, type OperationContext } from "../../src/contracts.js";
import { codingEnvironment, type RunnerConfig } from "../../src/flywheel/runner.js";
import { createJobService } from "../../src/flywheel/jobs.js";
import { assertVerifiedPreview, createVercelManager } from "../../src/flywheel/deploy.js";
import type { GraphClient } from "../../src/db/client.js";

const base = { schema_version: 1, owner_id: "test", created_at: new Date().toISOString(), provenance: provenanceOf("manager", null), completeness: COMPLETE };
const job = Job.parse({ ...base, job_id: newId("job"), application: "sample", repo_id: "repo", base_sha: "a".repeat(40), packet_id: newId("packet"), runner_config_id: "local", submission_key: "key",
  state: "completed", external_receipt: null, workspace_ref: "/test", result: { branch: "job/test", commit_sha: "b".repeat(40), artifact_ref: canonicalDigest({ artifact: 1 }), change_summary: "test", checks: [], requested_deployment: { url: "https://untrusted.invalid", project_id: "attacker" } }, deployment: null, version_id: null, error: null });
const packet = Packet.parse({ ...base, packet_id: job.packet_id, digest: canonicalDigest({}), application: "sample", parent_version_id: newId("version"), source: { repo_id: "repo", commit_sha: job.base_sha }, call_refs: [], feedback_ids: [], evidence_refs: [], snapshot: { calls: [], feedback: [], evidence: [] }, capture_policy: "sanitized-bounded-v1", reproduction: null, expected_outcome: null, change_summary: "test", successor_of: null, missing_refs: [] });
const config: RunnerConfig = { id: "local", executable: "/usr/bin/node", args: [], environment: {}, environmentAllowlist: [], writablePaths: ["src"], checks: [], timeoutMs: 1000, network: false };
function context(groups: ("management" | "development")[] = ["management"]): OperationContext {
  const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: "test", label: "test", groups, allow: { apps: ["sample"], repos: ["repo"] }, created_at: new Date().toISOString() });
  return { grant, principal: { owner_id: "test", grant_id: grant.grant_id, subject: "test", client_id: "test", session_id: null }, call_id: newId("call") };
}

describe("coding credential boundaries", () => {
  it.each(["VERCEL_TOKEN", "OWNER_TOKEN", "MANAGEMENT_TOKEN", "VERCEL_PROJECT_ID", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "HOME", "PATH", "GIT_CONFIG", "FLYWHEEL_DEVELOPMENT_TOKEN"])("rejects configured protected environment %s", (name) => {
    expect(() => codingEnvironment({ ...config, environment: { [name]: "secret" }, environmentAllowlist: [name] }, "scoped", job)).toThrow(/forbidden or non-allowlisted/);
  });
  it("does not inherit ambient credentials and allows only explicitly configured runner auth", () => {
    const result = codingEnvironment({ ...config, environment: { CODEX_HOME: "/opt/runner" }, environmentAllowlist: ["CODEX_HOME"] }, "development-only", job);
    expect(result).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/runner", LANG: "C.UTF-8", CODEX_HOME: "/opt/runner", FLYWHEEL_DEVELOPMENT_TOKEN: "development-only", FLYWHEEL_JOB_ID: job.job_id, FLYWHEEL_PACKET_ID: job.packet_id });
    expect(() => codingEnvironment({ ...config, environment: { OPENAI_API_KEY: "runner-key" } }, "", job)).toThrow();
  });
});

describe("manager trust boundaries", () => {
  it("denies DEVELOPMENT job operations before any persistence or packet reads", async () => {
    const getPacket = vi.fn();
    const handlers = createJobService({ db: {} as GraphClient, repositories: [], runnerConfigs: [], getPacket });
    const ctx = context(["development"]);
    await expect(handlers.start_job(ctx, { repo_id: "repo", base_sha: job.base_sha, packet_id: job.packet_id, runner_config_id: "local", idempotency_key: "deny" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(handlers.get_job(ctx, { job_id: job.job_id })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(getPacket).not.toHaveBeenCalled();
  });
  it("rejects a DEVELOPMENT caller at the privileged manager boundary before provider access", async () => {
    const fetcher = vi.fn();
    const manager = createVercelManager({ executable: "/usr/bin/false", projects: [], fetch: fetcher });
    await expect(manager.deployAndVerify({ ctx: context(["development"]), job, packet, artifact: { directory: "/test", digest: job.result!.artifact_ref } })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns explicit unavailable without using caller-requested URL/artifact as deployment authority", async () => {
    const fetcher = vi.fn();
    const manager = createVercelManager({ executable: "/usr/bin/false", projects: [], fetch: fetcher });
    await expect(manager.deployAndVerify({ ctx: context(), job, packet, artifact: { directory: "/test", digest: job.result!.artifact_ref } })).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => assertVerifiedPreview(job.result!.requested_deployment, job, packet)).toThrow(/missing required/);
  });
  it.each(["production", "wrong-repo", "wrong-commit", "wrong-schema"])("rejects forged verification %s", (change) => {
    const verification = { owner_id: job.owner_id, application: job.application, repo_id: job.repo_id, job_id: job.job_id, packet_id: packet.packet_id,
      commit_sha: job.result!.commit_sha, artifact_digest: job.result!.artifact_ref, deployment_id: "dpl_test", project_id: "prj_test", team_id: "team_test", url: "https://unique.vercel.app/mcp", target: "preview", ready_at: new Date().toISOString(), tools: [], schema_digest: canonicalDigest({ tools: [] }), auth_config_ref: "auth:test",
      checks: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
    const hostile = change === "production" ? { ...verification, target: "production" } : change === "wrong-repo" ? { ...verification, repo_id: "other" } : change === "wrong-commit" ? { ...verification, commit_sha: job.base_sha } : { ...verification, schema_digest: canonicalDigest({ wrong: true }) };
    expect(() => assertVerifiedPreview(hostile, job, packet)).toThrow();
  });
});

describe("Vercel provider failure gates", () => {
  const project = { ownerId: job.owner_id, application: job.application, repoId: job.repo_id, providerRepoId: "provider-repo", projectId: "prj_test", teamId: "team_test", mcpPath: "/mcp" };
  const input = () => ({ ctx: context(), job, packet, artifact: { directory: "/test", digest: job.result!.artifact_ref } });
  const saved = () => ({ owner_id: job.owner_id, application: job.application, repo_id: job.repo_id, job_id: job.job_id, packet_id: packet.packet_id,
    commit_sha: job.result!.commit_sha, artifact_digest: job.result!.artifact_ref, deployment_id: "dpl_test", project_id: "prj_test", team_id: "team_test", url: "https://unique.vercel.app/mcp", target: "preview" as const, ready_at: new Date().toISOString(), tools: [], schema_digest: canonicalDigest({ tools: [] }), auth_config_ref: "auth:test",
    checks: { deployment_ready: true as const, provenance_verified: true as const, schema_verified: true as const, auth_verified: true as const } });
  it("refuses first-deployment or mismatched existing project before invoking CLI", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "prj_test", accountId: "wrong-team", link: { repoId: "provider-repo" }, targets: {} }), { status: 200 }));
    const manager = createVercelManager({ executable: "/usr/bin/false", token: "manager-only", projects: [project], fetch: fetcher,
      verifyRuntime: async () => { throw new Error("Must not probe an unverified deployment."); } });
    await expect(manager.deployAndVerify(input())).rejects.toMatchObject({ shape: { code: "forbidden", outcome_certainty: "not_executed" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("refuses a provider-shaped production response without probing or credential forwarding", async () => {
    const verifier = vi.fn();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "dpl_test", url: "unique.vercel.app", projectId: "prj_test", ownerId: "team_test", readyState: "READY", target: "production", ready: Date.now(), meta: {} }), { status: 200 }));
    const manager = createVercelManager({ executable: "/usr/bin/false", token: "manager-only", projects: [project], fetch: fetcher, verifyRuntime: verifier });
    await expect(manager.verify(input(), saved())).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expect(verifier).not.toHaveBeenCalled();
  });
  it("refuses wrong resource/audience checks and supplies the runtime verifier only its verified target identity", async () => {
    const verifier = vi.fn(async (_target: { url: string; deploymentId: string; application: string; ownerId: string; schemaDigest?: string }) => ({ tools: [], schema_digest: canonicalDigest({ tools: [] }), auth_config_ref: "auth:test", initializeVerified: true, authVerified: true, resourceVerified: false }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "dpl_test", url: "unique.vercel.app", projectId: "prj_test", ownerId: "team_test", readyState: "READY", target: null, customEnvironment: null, ready: Date.now(),
      meta: { flywheelJobId: job.job_id, flywheelRepoId: job.repo_id, flywheelCommitSha: job.result!.commit_sha, flywheelArtifactDigest: job.result!.artifact_ref } }), { status: 200 }));
    const manager = createVercelManager({ executable: "/usr/bin/false", token: "manager-only", projects: [project], fetch: fetcher, verifyRuntime: verifier });
    await expect(manager.verify(input(), saved())).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expect(verifier.mock.calls[0]?.[0]).toEqual({ url: "https://unique.vercel.app/mcp", deploymentId: "dpl_test", application: job.application, ownerId: job.owner_id, repoId: job.repo_id, commitSha: job.result!.commit_sha, artifactDigest: job.result!.artifact_ref, projectId: project.projectId, teamId: project.teamId, jobId: job.job_id, packetId: packet.packet_id, schemaDigest: saved().schema_digest });
  });
});
