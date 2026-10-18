import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FlywheelError, InnerTool, Sha, Digest, Timestamp, canonicalDigest, type Job, type Packet, type OperationContext } from "../contracts.js";
import { canUseTool, assertAppInScope, assertRepoAllowed } from "../policy.js";

export const VerifiedPreview = z.object({
  owner_id: z.string(), application: z.string(), repo_id: z.string(), job_id: z.string(), packet_id: z.string(),
  commit_sha: Sha, artifact_digest: Digest, deployment_id: z.string().min(1), project_id: z.string().min(1), team_id: z.string().min(1),
  url: z.string().url(), target: z.literal("preview"), ready_at: Timestamp,
  tools: z.array(InnerTool), schema_digest: Digest, auth_config_ref: z.string().min(1),
  checks: z.object({ deployment_ready: z.literal(true), provenance_verified: z.literal(true), schema_verified: z.literal(true), auth_verified: z.literal(true) }),
});
export type VerifiedPreview = z.infer<typeof VerifiedPreview>;
export interface ManagerInput { ctx: OperationContext; job: Job; packet: Packet; artifact: { directory: string; digest: string } }
export interface ManagerAdapter {
  deployAndVerify(input: ManagerInput): Promise<VerifiedPreview>;
  /** Re-read provider identity and protected MCP readiness, without issuing a new deployment. */
  verify(input: ManagerInput, saved: VerifiedPreview): Promise<VerifiedPreview>;
}
export interface PreviewProject {
  ownerId: string; application: string; repoId: string; providerRepoId: string; projectId: string; teamId: string;
  /** Deployment-specific endpoint path; configured by the owner, never from job metadata. */
  mcpPath: string;
}
export interface RuntimeVerification {
  tools: z.infer<typeof InnerTool>[];
  schema_digest: string;
  auth_config_ref: string;
  initializeVerified: boolean;
  authVerified: boolean;
  resourceVerified: boolean;
}
export interface RuntimeVerificationTarget {
  url: string; deploymentId: string; application: string; ownerId: string;
  repoId: string; commitSha: string; artifactDigest: string; projectId: string; teamId: string;
  jobId: string; packetId: string; schemaDigest?: string;
}
export interface VercelManagerOptions {
  executable: string;
  token?: string;
  projects: readonly PreviewProject[];
  /** Uses server-owned OAuth credential mediation, including negative resource/audience tests.
   * No inbound bearer or Vercel token is supplied to this adapter. It must reject redirects. */
  verifyRuntime?: (target: RuntimeVerificationTarget) => Promise<RuntimeVerification>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function assertVerifiedPreview(input: unknown, job: Job, packet: Packet): VerifiedPreview {
  const parsed = VerifiedPreview.safeParse(input);
  if (!parsed.success) throw new FlywheelError("version_unavailable", "Manager verification is missing required deployment/schema/auth checks.");
  const v = parsed.data;
  if (!job.result || v.owner_id !== job.owner_id || v.application !== job.application || v.repo_id !== job.repo_id ||
      v.job_id !== job.job_id || v.packet_id !== packet.packet_id || packet.packet_id !== job.packet_id ||
      v.commit_sha !== job.result.commit_sha || v.artifact_digest !== job.result.artifact_ref ||
      v.schema_digest !== canonicalDigest({ tools: v.tools })) {
    throw new FlywheelError("forbidden", "Verified preview provenance does not match this job's actual artifact.");
  }
  const url = new URL(v.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new FlywheelError("forbidden", "Preview identity must be an HTTPS deployment-specific URL.");
  return v;
}

/** A manager-owned export of only the pinned Git commit, without worktree credentials or state. */
export async function exportCommittedArtifact(directory: string, commitSha: string, timeoutMs = 30_000): Promise<{ directory: string; dispose(): Promise<void> }> {
  Sha.parse(commitSha);
  const upload = await mkdtemp(path.join(tmpdir(), "flywheel-preview-upload-"));
  try {
    const archive = await promisify(execFile)("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", "-C", directory, "archive", "--format=tar", commitSha],
      { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "buffer", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    const unpack = promisify(execFile)("/usr/bin/tar", ["--extract", "--file=-", "--directory", upload],
      { env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" }, timeout: timeoutMs, maxBuffer: 64 * 1024 });
    unpack.child.stdin?.end(archive.stdout);
    await unpack;
    return { directory: upload, dispose: () => rm(upload, { recursive: true, force: true }) };
  } catch {
    await rm(upload, { recursive: true, force: true });
    throw new FlywheelError("operation_unavailable", "Exact committed artifact could not be exported; no deployment was requested.");
  }
}

/** Concrete CLI deployment plus provider API readback. No project creation, linking or production fallback. */
export function createVercelManager(options: VercelManagerOptions): ManagerAdapter {
  const request = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 180_000;
  function configured(input: ManagerInput): PreviewProject {
    if (input.ctx.principal.owner_id !== input.ctx.grant.owner_id || input.ctx.principal.grant_id !== input.ctx.grant.grant_id ||
        input.job.owner_id !== input.ctx.principal.owner_id || !canUseTool(input.ctx.grant, "flywheel", "register_preview") ||
        input.ctx.grant.scope.job_id || input.ctx.grant.scope.packet_id) {
      throw new FlywheelError("forbidden", "Only an active matching unscoped MANAGEMENT grant may operate the trusted preview manager.");
    }
    assertAppInScope(input.ctx.grant, input.job.application);
    assertRepoAllowed(input.ctx.grant, input.job.repo_id);
    if (input.job.state !== "completed" || !input.job.result || input.job.result.checks.some((check) => check.outcome !== "pass") ||
        input.packet.packet_id !== input.job.packet_id || input.packet.owner_id !== input.job.owner_id || input.packet.application !== input.job.application ||
        input.packet.source.repo_id !== input.job.repo_id || input.packet.source.commit_sha !== input.job.base_sha) {
      throw new FlywheelError("forbidden", "The preview manager requires the completed checked job and its exact persisted packet source.");
    }
    const project = options.projects.find((p) => p.ownerId === input.job.owner_id && p.application === input.job.application && p.repoId === input.job.repo_id);
    if (!project || !options.token || !options.verifyRuntime) throw new FlywheelError("operation_unavailable", "Preview deployment is not configured. Supply an existing Vercel team/project, manager credential and protected MCP verification adapter.");
    if (input.artifact.digest !== input.job.result?.artifact_ref) throw new FlywheelError("forbidden", "Deploy input does not match the job artifact.");
    if (!project.mcpPath.startsWith("/") || project.mcpPath.startsWith("//") || project.mcpPath.includes("?") || project.mcpPath.includes("#")) throw new FlywheelError("invalid_args", "Configure an absolute MCP endpoint path without an origin.");
    return project;
  }
  async function api(route: string): Promise<unknown> {
    try {
      const response = await request(`https://api.vercel.com${route}`, { headers: { Authorization: `Bearer ${options.token}` }, redirect: "error", signal: AbortSignal.timeout(timeout) });
      if (!response.ok) throw new Error("Provider request rejected");
      return await response.json();
    } catch { throw new FlywheelError("upstream_error", "Vercel identity/readiness lookup failed. Inspect the recorded deployment before retrying.", { certainty: "unknown", retryable: false }); }
  }
  async function preflight(project: PreviewProject): Promise<void> {
    const value = z.object({ id: z.string(), accountId: z.string(), link: z.object({ repoId: z.union([z.string(), z.number()]) }),
      targets: z.object({ production: z.object({ id: z.string() }) }) }).safeParse(
      await api(`/v9/projects/${encodeURIComponent(project.projectId)}?teamId=${encodeURIComponent(project.teamId)}`));
    if (!value.success || value.data.id !== project.projectId || value.data.accountId !== project.teamId || String(value.data.link.repoId) !== project.providerRepoId) {
      throw new FlywheelError("forbidden", "Existing project/team/repository and production baseline could not be verified; no deployment was requested.");
    }
  }
  async function inspect(input: ManagerInput, project: PreviewProject, deployment: string, expectedSchema?: string): Promise<VerifiedPreview> {
    const parsed = z.object({ id: z.string(), url: z.string(), projectId: z.string(), ownerId: z.string(), readyState: z.literal("READY"),
      target: z.union([z.literal("preview"), z.null()]), customEnvironment: z.unknown().nullish(),
      ready: z.number(), meta: z.record(z.string(), z.unknown()) }).safeParse(
      await api(`/v13/deployments/${encodeURIComponent(deployment)}?teamId=${encodeURIComponent(project.teamId)}`));
    if (!parsed.success) throw new FlywheelError("version_unavailable", "Deployment is not a confirmed ready preview; production and custom targets are rejected.");
    const data = parsed.data;
    if (data.projectId !== project.projectId || data.ownerId !== project.teamId || data.customEnvironment != null ||
        data.meta.flywheelJobId !== input.job.job_id || data.meta.flywheelRepoId !== input.job.repo_id ||
        data.meta.flywheelCommitSha !== input.job.result?.commit_sha || data.meta.flywheelArtifactDigest !== input.artifact.digest) {
      throw new FlywheelError("forbidden", "Provider deployment provenance or project identity differs from the trusted manager upload.");
    }
    if (!/^[a-zA-Z0-9-]+\.vercel\.app$/.test(data.url)) throw new FlywheelError("forbidden", "Provider returned an unexpected deployment host.");
    const url = `https://${data.url}${project.mcpPath}`;
    const runtime = await options.verifyRuntime!({ url, deploymentId: data.id, application: project.application, ownerId: project.ownerId, repoId: project.repoId, commitSha: input.job.result!.commit_sha, artifactDigest: input.artifact.digest, projectId: project.projectId, teamId: project.teamId, jobId: input.job.job_id, packetId: input.packet.packet_id, ...(expectedSchema ? { schemaDigest: expectedSchema } : {}) });
    if (!runtime.initializeVerified || !runtime.authVerified || !runtime.resourceVerified || runtime.schema_digest !== canonicalDigest({ tools: runtime.tools }) || (expectedSchema && expectedSchema !== runtime.schema_digest)) {
      throw new FlywheelError("version_unavailable", "Protected MCP initialize/schema/resource/audience checks did not pass.");
    }
    return assertVerifiedPreview({ owner_id: input.job.owner_id, application: project.application, repo_id: project.repoId,
      job_id: input.job.job_id, packet_id: input.job.packet_id, commit_sha: input.job.result!.commit_sha, artifact_digest: input.artifact.digest,
      deployment_id: data.id, project_id: project.projectId, team_id: project.teamId, url, target: "preview", ready_at: new Date(data.ready).toISOString(),
      tools: runtime.tools, schema_digest: runtime.schema_digest, auth_config_ref: runtime.auth_config_ref,
      checks: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } }, input.job, input.packet);
  }
  return {
    async deployAndVerify(input) {
      const project = configured(input);
      await preflight(project);
      // Export immutable Git content. Never upload ignored files or CLI state from a worktree.
      const upload = await exportCommittedArtifact(input.artifact.directory, input.job.result!.commit_sha, timeout);
      let stdout: string;
      try {
        const result = await promisify(execFile)(options.executable, ["deploy", upload.directory, "--yes", "--target=preview", "--no-color",
          "--meta", `flywheelJobId=${input.job.job_id}`, "--meta", `flywheelRepoId=${input.job.repo_id}`,
          "--meta", `flywheelCommitSha=${input.job.result!.commit_sha}`, "--meta", `flywheelArtifactDigest=${input.artifact.digest}`],
        { cwd: upload.directory, env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent", VERCEL_TOKEN: options.token!,
          VERCEL_PROJECT_ID: project.projectId, VERCEL_ORG_ID: project.teamId, VERCEL_TELEMETRY_DISABLED: "1", CI: "1" },
          timeout, maxBuffer: 1024 * 1024 });
        stdout = result.stdout.trim();
      } catch { throw new FlywheelError("outcome_unknown", "Vercel CLI did not return a deployment receipt. Reconcile by trusted job metadata; do not repeat deploy.", { retryable: false }); }
      finally { await upload.dispose(); }
      if (!/^https:\/\/[a-zA-Z0-9-]+\.vercel\.app\/?$/.test(stdout)) throw new FlywheelError("outcome_unknown", "Vercel returned no unique deployment URL; inspect provider state before retrying.", { retryable: false });
      return inspect(input, project, new URL(stdout).hostname);
    },
    async verify(input, saved) {
      const project = configured(input);
      const verified = await inspect(input, project, saved.deployment_id, saved.schema_digest);
      if (verified.deployment_id !== saved.deployment_id || verified.url !== saved.url || verified.project_id !== saved.project_id || verified.team_id !== saved.team_id || verified.auth_config_ref !== saved.auth_config_ref) {
        throw new FlywheelError("forbidden", "Deployment identity changed since verification.");
      }
      return verified;
    },
  };
}
