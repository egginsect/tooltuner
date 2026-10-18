import {
  Job, Grant, FlywheelError, newId, canonicalDigest, provenanceOf, COMPLETE,
  StartJobInput, GetJobInput, RegisterPreviewInput,
  type Packet, type OperationContext, type FlywheelHandlers,
} from "../contracts.js";
import { assertAppInScope, assertRepoAllowed, canUseTool } from "../policy.js";
import { insertGrant, listGrants, revokeGrant } from "../db/auth.js";
import { claimJob, getJob, updateJob, claimDeployment, saveJobVerification, getJobVerification, linkJob, jobStorage } from "../db/jobs.js";
import type { GraphClient } from "../db/client.js";
import type { RunnerAdapter, RunnerConfig, TrustedRepository, RunnerObservation } from "./runner.js";
import { assertVerifiedPreview, type ManagerAdapter, type VerifiedPreview } from "./deploy.js";

export type JobHandlers = Pick<Required<FlywheelHandlers>, "start_job" | "get_job" | "register_preview">;
export interface JobServiceOptions {
  db: GraphClient;
  repositories: readonly TrustedRepository[];
  runnerConfigs: readonly RunnerConfig[];
  runner?: RunnerAdapter;
  getPacket(db: GraphClient, ownerId: string, packetId: string): Promise<Packet | null>;
  /** Called only after insertGrant; must mint only this persisted DEVELOPMENT grant.
   * Plaintext stays in memory and the explicit child environment. */
  issueDevelopmentToken?: (grant: Grant) => Promise<string>;
  manager?: ManagerAdapter;
  /** Trusted registry adapter; must be idempotent by job_id and must never write STABLE. */
  registerPreview?: (ctx: OperationContext, job: Job, packet: Packet, verification: VerifiedPreview) => Promise<{ version_id: string; state: "pending_checks" | "ready" | "failed" | "unavailable"; missing_checks: string[] }>;
}

export function authorizeJobOperation(ctx: OperationContext, op: "start_job" | "get_job" | "register_preview", application?: string): void {
  if (ctx.principal.owner_id !== ctx.grant.owner_id || ctx.principal.grant_id !== ctx.grant.grant_id || !canUseTool(ctx.grant, "flywheel", op)) {
    throw new FlywheelError("forbidden", "A matching active MANAGEMENT grant is required.");
  }
  if (application) assertAppInScope(ctx.grant, application);
}
function observation(job: Job, value: RunnerObservation): Job {
  if (value.state === "running") return Job.parse({ ...job, state: "running", external_receipt: value.receipt, workspace_ref: value.workspaceRef, error: null });
  if (value.state === "completed") return Job.parse({ ...job, state: "completed", result: value.result, workspace_ref: value.workspaceRef, error: null });
  return Job.parse({ ...job, state: value.state, error: value.error.shape, ...(value.result ? { result: value.result } : {}), ...(value.workspaceRef ? { workspace_ref: value.workspaceRef } : {}),
    completeness: { status: value.state === "unknown" ? "unknown" : "partial", missing_refs: [], notes: [value.error.message] } });
}

export function createJobService(options: JobServiceOptions): JobHandlers {
  const { db } = options;
  // Only prevents duplicate local polling; the durable compare-and-set is authoritative across managers.
  const pending = new Map<string, Promise<Job>>();
  async function packetFor(job: Job): Promise<Packet> {
    const packet = await options.getPacket(db, job.owner_id, job.packet_id);
    if (!packet || packet.owner_id !== job.owner_id || packet.application !== job.application || packet.source.repo_id !== job.repo_id || packet.source.commit_sha !== job.base_sha) {
      throw new FlywheelError("not_found", "Job packet is unavailable or outside its application/repository/base scope.");
    }
    return packet;
  }
  async function scopedJob(ctx: OperationContext, id: string, op: "get_job" | "register_preview"): Promise<Job> {
    authorizeJobOperation(ctx, op);
    const job = await getJob(db, ctx.principal.owner_id, id);
    if (!job) throw new FlywheelError("not_found", "Job was not found.");
    assertAppInScope(ctx.grant, job.application);
    assertRepoAllowed(ctx.grant, job.repo_id);
    if ((ctx.grant.scope.job_id && ctx.grant.scope.job_id !== job.job_id) || (ctx.grant.scope.packet_id && ctx.grant.scope.packet_id !== job.packet_id)) throw new FlywheelError("not_found", "Job was not found.");
    return job;
  }
  async function revokeDevelopment(job: Job): Promise<void> {
    const grants = await jobStorage(() => listGrants(db, job.owner_id));
    for (const grant of grants.filter((g) => g.scope.job_id === job.job_id && g.revoked_at === null)) {
      await jobStorage(() => revokeGrant(db, grant.grant_id, new Date().toISOString(), job.owner_id));
    }
  }
  async function registration(ctx: OperationContext, job: Job, packet: Packet, saved: unknown): Promise<{ job: Job; output: Awaited<ReturnType<NonNullable<JobServiceOptions["registerPreview"]>>> }> {
    authorizeJobOperation(ctx, "register_preview", job.application);
    if (ctx.grant.scope.job_id || ctx.grant.scope.packet_id) throw new FlywheelError("forbidden", "Scoped job capabilities cannot register previews.");
    if (!options.manager || !options.runner || !options.registerPreview) throw new FlywheelError("operation_unavailable", "Trusted preview manager/registry adapter is not configured.");
    const verified = assertVerifiedPreview(saved, job, packet);
    if (!job.deployment || job.deployment.deployment_id !== verified.deployment_id || job.deployment.url !== verified.url || job.deployment.commit_sha !== verified.commit_sha || job.deployment.project_id !== verified.project_id) throw new FlywheelError("forbidden", "Saved deployment differs from its manager verification.");
    const artifact = await options.runner.verifyArtifact(job);
    const fresh = assertVerifiedPreview(await options.manager.verify({ ctx, job, packet, artifact }, verified), job, packet);
    const output = await options.registerPreview(ctx, job, packet, fresh);
    if (output.state !== "ready" || output.missing_checks.length) throw new FlywheelError("version_unavailable", "Registry did not confirm a fully verified preview.");
    if (job.version_id && job.version_id !== output.version_id) throw new FlywheelError("ingest_conflict", "Registry returned a different candidate for this job.");
    const next = job.version_id ? job : await updateJob(db, job, { ...job, version_id: output.version_id, error: null });
    await linkJob(db, next);
    return { job: next, output };
  }
  async function coordinate(ctx: OperationContext, initial: Job): Promise<Job> {
    let job = initial;
    if (["queued", "launching", "running", "unknown"].includes(job.state)) {
      if (job.state === "queued") {
        // There is no scheduler: an orphaned queued request has never been confirmed launched.
        return updateJob(db, job, { ...job, state: "failed", error: new FlywheelError("operation_unavailable", "Queued request was interrupted before launch; no automatic retry was made.").shape });
      }
      const value = options.runner ? await options.runner.reconcile(job) : { state: "unknown" as const, error: new FlywheelError("outcome_unknown", "Runner is unavailable; reconcile the existing job, never resubmit blindly.") };
      job = await updateJob(db, job, observation(job, value));
    }
    if (["completed", "failed", "cancelled", "unknown"].includes(job.state)) await revokeDevelopment(job);
    if (job.state !== "completed" || job.version_id) return job;
    if (!canUseTool(ctx.grant, "flywheel", "register_preview") || ctx.grant.scope.job_id || ctx.grant.scope.packet_id) return job;
    const packet = await packetFor(job);
    try {
      if (!job.result?.checks.length || job.result.checks.some((check) => check.outcome !== "pass")) throw new FlywheelError("version_unavailable", "Preview deployment requires actual passing configured artifact checks.");
      let saved = await getJobVerification(db, job.owner_id, job.job_id);
      if (!saved) {
        if (!options.manager || !options.runner || !options.registerPreview) {
          if (!job.error) job = await updateJob(db, job, { ...job, error: new FlywheelError("operation_unavailable", "Coding output is complete; trusted preview deployment/verification is not configured.").shape });
          return job;
        }
        const artifact = await options.runner.verifyArtifact(job);
        if (!await claimDeployment(db, job)) {
          if (!job.error) job = await updateJob(db, job, { ...job, error: new FlywheelError("outcome_unknown", "A previous deployment attempt has no verified receipt. Reconcile provider state by job ID; no deployment was repeated.", { retryable: false }).shape });
          return job;
        }
        job = await updateJob(db, job, { ...job, error: new FlywheelError("outcome_unknown", "Manager deployment is in progress; do not resubmit.", { retryable: false }).shape });
        saved = assertVerifiedPreview(await options.manager.deployAndVerify({ ctx, job, packet, artifact }), job, packet);
        await saveJobVerification(db, job, saved);
      }
      const verified = assertVerifiedPreview(saved, job, packet);
      if (!job.deployment) job = await updateJob(db, job, { ...job, deployment: {
        deployment_id: verified.deployment_id, url: verified.url, project_id: verified.project_id, commit_sha: verified.commit_sha, target: "preview", ready_at: verified.ready_at,
      }, error: null });
      return (await registration(ctx, job, packet, saved)).job;
    } catch (error) {
      if (error instanceof FlywheelError && error.shape.code === "storage_unavailable") throw error;
      const failure = error instanceof FlywheelError ? error : new FlywheelError("outcome_unknown", "Preview coordination failed; inspect the saved deployment attempt before retrying.", { retryable: false });
      const current = await getJob(db, job.owner_id, job.job_id);
      if (!current) throw failure;
      return updateJob(db, current, { ...current, error: failure.shape });
    }
  }
  return {
    async start_job(ctx, raw) {
      authorizeJobOperation(ctx, "start_job");
      const input = StartJobInput.parse(raw);
      const packet = await options.getPacket(db, ctx.principal.owner_id, input.packet_id);
      if (!packet || packet.owner_id !== ctx.principal.owner_id) throw new FlywheelError("not_found", "Packet was not found.");
      assertAppInScope(ctx.grant, packet.application);
      assertRepoAllowed(ctx.grant, input.repo_id);
      if (ctx.grant.scope.job_id || (ctx.grant.scope.packet_id && ctx.grant.scope.packet_id !== packet.packet_id)) throw new FlywheelError("forbidden", "Scoped job grants cannot launch another job.");
      const repository = options.repositories.find((r) => r.ownerId === ctx.principal.owner_id && r.repoId === input.repo_id && r.application === packet.application);
      if (!repository || !repository.allowedBaseShas.includes(input.base_sha) || !repository.runnerConfigIds.includes(input.runner_config_id) ||
          packet.source.repo_id !== input.repo_id || packet.source.commit_sha !== input.base_sha) {
        throw new FlywheelError("forbidden", "Repository, full base SHA, runner configuration and frozen packet must agree with trusted configuration.");
      }
      const config = options.runnerConfigs.find((r) => r.id === input.runner_config_id);
      const initial = Job.parse({ schema_version: 1, owner_id: ctx.principal.owner_id, created_at: new Date().toISOString(),
        provenance: provenanceOf("manager", ctx.principal), completeness: COMPLETE, job_id: newId("job"), application: packet.application,
        repo_id: input.repo_id, base_sha: input.base_sha, packet_id: input.packet_id, runner_config_id: input.runner_config_id,
        submission_key: input.idempotency_key, state: "queued", external_receipt: null, workspace_ref: null, result: null, deployment: null, version_id: null, error: null });
      const claimed = await claimJob(db, initial, canonicalDigest({ ...input, packet_digest: packet.digest }));
      if (!claimed.created) return { job_id: claimed.job.job_id, state: claimed.job.state, receipt_ref: claimed.job.external_receipt?.run_id ?? null };
      let job = claimed.job;
      await linkJob(db, job);
      if (!options.runner || !config || !options.issueDevelopmentToken) {
        job = await updateJob(db, job, { ...job, state: "failed", error: new FlywheelError("operation_unavailable", "Coding runner, runner configuration or scoped development credential issuer is not configured.").shape });
      } else {
        job = await updateJob(db, job, { ...job, state: "launching" });
        try {
          const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: job.owner_id, label: `Coding ${job.job_id}`,
            groups: ["development"], allow: { apps: [job.application], tools: { flywheel: ["get_context", "get_evidence"] }, repos: [job.repo_id] },
            scope: { job_id: job.job_id, packet_id: job.packet_id }, created_at: new Date().toISOString(), revoked_at: null });
          await jobStorage(() => insertGrant(db, grant));
          const developmentToken = await options.issueDevelopmentToken(grant);
          if (!developmentToken) throw new FlywheelError("operation_unavailable", "Development credential issuer returned no capability.");
          const value = await options.runner.launch({ job, packet, repository, config, developmentGrant: grant, developmentToken });
          job = await updateJob(db, job, observation(job, value));
        } catch (error) {
          if (error instanceof FlywheelError && error.shape.code === "storage_unavailable") throw error;
          const failure = error instanceof FlywheelError ? error : new FlywheelError("outcome_unknown", "Runner launch outcome cannot be confirmed; reconcile this job before another launch.");
          job = await updateJob(db, job, { ...job, state: failure.shape.outcome_certainty === "unknown" ? "unknown" : "failed", error: failure.shape });
          await revokeDevelopment(job);
        }
      }
      return { job_id: job.job_id, state: job.state, receipt_ref: job.external_receipt?.run_id ?? null };
    },
    async get_job(ctx, raw) {
      const input = GetJobInput.parse(raw);
      const job = await scopedJob(ctx, input.job_id, "get_job");
      let work = pending.get(job.job_id);
      if (!work) {
        work = coordinate(ctx, job);
        pending.set(job.job_id, work);
        void work.finally(() => { pending.delete(job.job_id); }).catch(() => undefined);
      }
      return { job: await work };
    },
    async register_preview(ctx, raw) {
      const input = RegisterPreviewInput.parse(raw);
      const job = await scopedJob(ctx, input.job_id, "register_preview");
      const packet = await packetFor(job);
      if (job.state !== "completed" || !job.result || !job.deployment || input.application !== job.application ||
          input.parent_version !== packet.parent_version_id || input.artifact_ref !== job.result.artifact_ref || input.deployment_ref !== job.deployment.deployment_id) {
        throw new FlywheelError("forbidden", "Preview request does not match the completed job, frozen parent, artifact and verified deployment.");
      }
      const saved = await getJobVerification(db, job.owner_id, job.job_id);
      return (await registration(ctx, job, packet, saved)).output;
    },
  };
}
