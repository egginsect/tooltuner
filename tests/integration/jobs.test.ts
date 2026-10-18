import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { COMPLETE, Grant, Job, Packet, Version, FlywheelError, newId, canonicalDigest, provenanceOf, PACKET_DIGEST_EXCLUDED, type OperationContext } from "../../src/contracts.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { AUTH_INDEX_SPECS, listGrants, insertGrant } from "../../src/db/auth.js";
import { JOB_INDEX_SPECS, getJob, updateJob } from "../../src/db/jobs.js";
import { EVIDENCE_INDEX_SPECS, freezePacket, getPacket, getCall } from "../../src/db/evidence.js";
import { REGISTRY_INDEX_SPECS, insertApplication, insertVersion, versionDigest } from "../../src/db/registry.js";
import { exportCommittedArtifact } from "../../src/flywheel/deploy.js";
import { createEvidenceService } from "../../src/flywheel/evidence.js";
import { createJobService } from "../../src/flywheel/jobs.js";
import { createLocalRunner, git, type RunnerConfig, type TrustedRepository, type RunnerAdapter } from "../../src/flywheel/runner.js";

let db: GraphClient;
let root: string;
let sha: string;
let packet: Packet;
let ctx: OperationContext;
let repository: TrustedRepository;
let runner: RunnerAdapter;
let config: RunnerConfig;
const owner = `jobs_${randomUUID()}`;
const url = process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379";

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "flywheel-jobs-"));
  const repo = path.join(root, "source");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "src/value.txt"), "baseline");
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["add", "src/value.txt"]);
  await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "test-owned baseline"]);
  sha = await git(repo, ["rev-parse", "HEAD"]);
  // Untracked state in the source is never copied into the job worktree.
  await writeFile(path.join(repo, ".env"), "VERCEL_TOKEN=test-secret");
  db = await GraphClient.connect({ url, graph: `jobs_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, [...AUTH_INDEX_SPECS, ...JOB_INDEX_SPECS, ...EVIDENCE_INDEX_SPECS, ...REGISTRY_INDEX_SPECS]);
  const grant = Grant.parse({ schema_version: 1, owner_id: owner, grant_id: newId("grant"), label: "test management", groups: ["management"], allow: { apps: ["sample"], repos: ["test-repo"] }, created_at: new Date().toISOString() });
  ctx = { grant, principal: { owner_id: owner, grant_id: grant.grant_id, subject: "test", client_id: "test", session_id: null }, call_id: newId("call") };
  const content = Packet.parse({ schema_version: 1, owner_id: owner, created_at: new Date().toISOString(), provenance: provenanceOf("flywheel", ctx.principal), completeness: COMPLETE,
    packet_id: newId("packet"), digest: canonicalDigest({}), application: "sample", parent_version_id: newId("version"), source: { repo_id: "test-repo", commit_sha: sha }, call_refs: [], feedback_ids: [], evidence_refs: [], snapshot: { calls: [], feedback: [], evidence: [] }, capture_policy: "sanitized-bounded-v1", reproduction: null, expected_outcome: null, change_summary: "Synthetic local process verification", successor_of: null, missing_refs: [] });
  const metadata = { schema_version: 1 as const, owner_id: owner, created_at: new Date().toISOString(), provenance: provenanceOf("seed", null), completeness: COMPLETE };
  await insertApplication(db, { ...metadata, application: "sample", description: "Test-owned local runner source", kind: "upstream" });
  const baseline = Version.parse({ ...metadata, version_id: content.parent_version_id, label: "v1", digest: canonicalDigest({}), application: "sample", parent_version_id: null,
    source: content.source, tools: [], schema_digest: canonicalDigest({ tools: [] }), runtime_target: { kind: "mcp_streamable_http", url: "http://127.0.0.1:1/mcp", deployment_id: null, environment: "local" },
    auth_config_ref: null, verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, state: "pending_checks", readiness: { deployment_ready: false, provenance_verified: false, schema_verified: false, auth_verified: false } });
  await insertVersion(db, { ...baseline, digest: versionDigest(baseline) });
  const trace = await createEvidenceService(db).recorder.admit({ principal: ctx.principal, application: "sample", tool: "local_probe", requested_version: baseline.version_id,
    resolved_version: baseline.version_id, schema_digest: baseline.schema_digest, idempotency_key: null, args: { local: "graph scope probe" }, causal_refs: [] });
  const call = (await getCall(db, owner, trace.call_id))!;
  const frozen = { ...content, call_refs: [trace.call_id], snapshot: { calls: [{ ...call }], feedback: [], evidence: [] } };
  packet = await freezePacket(db, { ...frozen, digest: canonicalDigest(frozen, PACKET_DIGEST_EXCLUDED) });
  repository = { repoId: "test-repo", ownerId: owner, application: "sample", localPath: repo, allowedBaseShas: [sha], runnerConfigIds: ["test-node", "missing-cli", "slow-cli", "failed-check"] };
  runner = createLocalRunner({ workspaceRoot: path.join(root, "jobs") });
  // This is an inert test-owned program, not a coding task against a user repository.
  const script = `const fs=require('node:fs');const assert=require('node:assert/strict');
    assert.equal(process.env.VERCEL_TOKEN,undefined);assert.equal(process.env.OWNER_TOKEN,undefined);assert.equal(process.env.MANAGEMENT_TOKEN,undefined);
    assert.equal(process.env.HOME,'/home/runner');assert.equal(process.env.FLYWHEEL_DEVELOPMENT_TOKEN,'job-only-test-capability');
    assert.equal(fs.existsSync('/workspace/.env'),false);assert.equal(fs.existsSync(${JSON.stringify(repo)}),false);
    assert.throws(()=>fs.writeFileSync('/workspace/escape.txt','blocked'));assert.throws(()=>fs.writeFileSync('/workspace/.claude/state','blocked'));
    fs.writeFileSync('/workspace/src/value.txt','actual local child output');`;
  config = { id: "test-node", executable: "/usr/bin/node", args: ["-e", script], environment: {}, environmentAllowlist: [], writablePaths: ["src"], checks: [{ name: "output", executable: "/usr/bin/node", args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('/workspace/src/value.txt','utf8'),'actual local child output')"] }], timeoutMs: 5000, network: false };
});
afterAll(async () => {
  if (db) { try { await db.dropGraph(); } finally { await db.close(); } }
  if (root) await rm(root, { recursive: true, force: true });
});
const service = (configs = [config], adapter = runner) => createJobService({ db, repositories: [repository], runnerConfigs: configs, runner: adapter, getPacket, issueDevelopmentToken: async (grant) => {
  expect(grant.groups).toEqual(["development"]);
  expect(grant.scope.packet_id).toBe(packet.packet_id);
  expect(grant.allow.repos).toEqual(["test-repo"]);
  return "job-only-test-capability";
} });
const request = (key: string, runnerConfig = "test-node") => ({ repo_id: "test-repo", base_sha: sha, packet_id: packet.packet_id, runner_config_id: runnerConfig, idempotency_key: key });
async function completed(handlers: ReturnType<typeof service>, id: string): Promise<Job> {
  for (let i = 0; i < 100; i++) {
    const current = (await handlers.get_job(ctx, { job_id: id })).job;
    if (!["launching", "running", "unknown"].includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Local child did not finish within the test budget.");
}

describe("real isolated runner and durable job service", () => {
  it("starts a real sandboxed child, captures output in its own git worktree, and deduplicates concurrent submissions", async () => {
    const handlers = service();
    const launches = await Promise.all([handlers.start_job(ctx, request("launch")), handlers.start_job(ctx, request("launch"))]);
    expect(new Set(launches.map((j) => j.job_id)).size).toBe(1);
    const started = await getJob(db, owner, launches[0]!.job_id);
    expect(started?.error).toBeNull();
    expect(started).toMatchObject({ state: "running", external_receipt: { runner: "local-bubblewrap" } });
    expect(started!.external_receipt!.pid).toBeGreaterThan(0);
    const result = await completed(handlers, started!.job_id);
    expect(result).toMatchObject({ state: "completed", result: { checks: [{ name: "output", outcome: "pass" }] }, deployment: null, version_id: null, error: { code: "operation_unavailable" } });
    expect(result.result!.commit_sha).not.toBe(sha);
    expect((await runner.verifyArtifact(result)).digest).toBe(result.result!.artifact_ref);
    expect(await readFile(path.join(repository.localPath, "src/value.txt"), "utf8")).toBe("baseline");
    expect(await git(repository.localPath, ["rev-parse", "HEAD"])).toBe(sha);
    expect(await git(repository.localPath, ["branch", "--list", "job/*"])).toBe("");
    const grants = await listGrants(db, owner);
    expect(grants.filter((g) => g.scope.job_id === result.job_id)).toMatchObject([{ groups: ["development"], revoked_at: expect.any(String) }]);
    await expect(handlers.start_job(ctx, { ...request("launch"), runner_config_id: "missing-cli" })).rejects.toMatchObject({ shape: { code: "idempotency_conflict" } });
    await expect(handlers.register_preview(ctx, { job_id: result.job_id, application: "sample", parent_version: packet.parent_version_id, artifact_ref: "caller-artifact", deployment_ref: "caller-url" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    const reopened = await GraphClient.connect({ url, graph: db.graphName });
    try { expect((await getJob(reopened, owner, result.job_id))?.result?.artifact_ref).toBe(result.result!.artifact_ref); }
    finally { await reopened.close(); }
    await writeFile(path.join(result.workspace_ref!, "src/value.txt"), "tampered output");
    await expect(runner.verifyArtifact(result)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    const upload = await exportCommittedArtifact(result.workspace_ref!, result.result!.commit_sha);
    try {
      expect(await readFile(path.join(upload.directory, "src/value.txt"), "utf8")).toBe("actual local child output");
      await expect(access(path.join(upload.directory, ".git"))).rejects.toThrow();
      await expect(access(path.join(upload.directory, ".env"))).rejects.toThrow();
    } finally { await upload.dispose(); }
  });
  it("exposes the persisted job through frozen evidence context and only its scoped packet closure", async () => {
    const handlers = createJobService({ db, repositories: [repository], runnerConfigs: [config], getPacket });
    const first = await handlers.start_job(ctx, request("scope-first"));
    const unrelated = await handlers.start_job(ctx, request("scope-other"));
    const grant = Grant.parse({ ...ctx.grant, grant_id: newId("grant"), label: "test scoped development", groups: ["development"],
      scope: { job_id: first.job_id, packet_id: packet.packet_id } });
    await insertGrant(db, grant);
    const scoped = { ...ctx, grant, principal: { ...ctx.principal, grant_id: grant.grant_id } };
    const evidence = createEvidenceService(db).handlers;
    const read = await evidence.get_evidence!(scoped, { refs: [first.job_id, packet.packet_id, unrelated.job_id] });
    expect(read.items.map((item) => item.ref)).toEqual(expect.arrayContaining([first.job_id, packet.packet_id]));
    expect(read.missing_refs).toEqual([unrelated.job_id]);
    const context = await evidence.get_context!(scoped, { application: "sample", version: packet.parent_version_id, call_ref: packet.call_refs[0]!, limit: 50 });
    expect(context.items.some((item) => item.ref === first.job_id)).toBe(true);
    expect(context.items.some((item) => item.ref === unrelated.job_id)).toBe(false);
    expect(context.lineage).toContainEqual({ from: first.job_id, rel: "FOR_PACKET", to: packet.packet_id });
    const scalar = await db.roQuery<{ at: string }>("MATCH (j:Job {job_id:$id}) RETURN j.created_at AS at", { id: first.job_id });
    expect(scalar[0]?.at).toBe((await getJob(db, owner, first.job_id))?.created_at);
  });
  it("rejects wrong base and repository before any job or process is created", async () => {
    await expect(service().start_job(ctx, { ...request("wrong-base"), base_sha: "f".repeat(40) })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(service().start_job(ctx, { ...request("wrong-repo"), repo_id: "other" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
  });
  it("persists missing CLI failure without manufacturing a process-start receipt", async () => {
    const handlers = service([{ ...config, id: "missing-cli", executable: "/usr/bin/flywheel-no-such-cli" }]);
    const result = await handlers.start_job(ctx, request("missing", "missing-cli"));
    expect(result).toMatchObject({ state: "failed", receipt_ref: null });
    expect(await getJob(db, owner, result.job_id)).toMatchObject({ state: "failed", external_receipt: null, error: { code: "operation_unavailable" } });
  });
  it("exposes restart uncertainty and never relaunches an existing job key", async () => {
    const handlers = service();
    const result = await handlers.start_job(ctx, request("restart"));
    const freshRunner = createLocalRunner({ workspaceRoot: path.join(root, "jobs") });
    const restarted = service([config], freshRunner);
    expect((await restarted.get_job(ctx, { job_id: result.job_id })).job).toMatchObject({ state: "unknown", error: { code: "outcome_unknown" } });
    expect(await restarted.start_job(ctx, request("restart"))).toMatchObject({ job_id: result.job_id, state: "unknown" });
    // Let the real test-owned child exit; no directory is removed while its process is active.
    await completed(handlers, result.job_id);
  });
  it("records actual failed check evidence and artifact provenance without deploying it", async () => {
    const handlers = service([{ ...config, id: "failed-check", checks: [{ name: "deliberate-failure", executable: "/usr/bin/node", args: ["-e", "process.exit(1)"] }] }]);
    const started = await handlers.start_job(ctx, request("failed-check", "failed-check"));
    const result = await completed(handlers, started.job_id);
    expect(result).toMatchObject({ state: "failed", deployment: null, result: { checks: [{ name: "deliberate-failure", outcome: "fail" }] }, error: { code: "invalid_args", outcome_certainty: "executed" } });
    expect(result.result!.artifact_ref).toMatch(/^sha256:/);
  });
  it("terminates a real over-budget child, retains its start receipt and exposes uncertainty", async () => {
    const handlers = service([{ ...config, id: "slow-cli", timeoutMs: 300, args: ["-e", "setTimeout(()=>{},5000)"], checks: [] }]);
    const started = await handlers.start_job(ctx, request("timeout", "slow-cli"));
    expect(started.state).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 350));
    const result = (await handlers.get_job(ctx, { job_id: started.job_id })).job;
    expect(result).toMatchObject({ state: "unknown", external_receipt: { runner: "local-bubblewrap" }, result: null, error: { code: "outcome_unknown" } });
    expect(await handlers.start_job(ctx, request("timeout", "slow-cli"))).toMatchObject({ job_id: started.job_id, state: "unknown" });
  });
  it("claims an uncertain manager deployment once and never retries it or trusts subprocess requests", async () => {
    let attempts = 0;
    const handlers = createJobService({ db, repositories: [repository], runnerConfigs: [config], runner, getPacket,
      issueDevelopmentToken: async () => "job-only-test-capability",
      manager: {
        async deployAndVerify() { attempts++; throw new FlywheelError("outcome_unknown", "test-owned lost manager receipt", { retryable: false }); },
        async verify() { throw new Error("No verified deployment exists."); },
      },
      async registerPreview() { throw new Error("An uncertain deployment must never be registered."); },
    });
    const started = await handlers.start_job(ctx, request("deployment-uncertain"));
    const result = await completed(handlers, started.job_id);
    expect(result).toMatchObject({ state: "completed", deployment: null, version_id: null, error: { code: "outcome_unknown" } });
    await handlers.get_job(ctx, { job_id: started.job_id });
    expect(attempts).toBe(1);
  });
  it("returns explicit unavailable when runner credentials are not configured, after persisting queued", async () => {
    const handlers = createJobService({ db, repositories: [repository], runnerConfigs: [config], getPacket });
    const result = await handlers.start_job(ctx, request("unconfigured"));
    expect(result.state).toBe("failed");
    expect(await getJob(db, owner, result.job_id)).toMatchObject({ external_receipt: null, error: { code: "operation_unavailable", outcome_certainty: "not_executed" } });
  });
  it("guards state updates using the durable previous snapshot", async () => {
    const result = await service().start_job(ctx, request("cas"));
    const old = (await getJob(db, owner, result.job_id))!;
    const changed = await updateJob(db, old, { ...old, error: { code: "outcome_unknown", message: "test-owned uncertainty", retryable: false, outcome_certainty: "unknown" } });
    await expect(updateJob(db, old, { ...old, error: null })).rejects.toMatchObject({ shape: { code: "outcome_unknown" } });
    expect((await getJob(db, owner, changed.job_id))?.error?.message).toBe("test-owned uncertainty");
    await completed(service(), result.job_id);
  });
});
