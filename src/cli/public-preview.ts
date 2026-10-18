/** Explicit owner-only anonymous Vercel preview enrollment, separate from protected managers. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { z } from "zod";
import { FlywheelError, Version } from "../contracts.js";
import type { GraphClient } from "../db/client.js";
import { getVersion } from "../db/registry.js";
import { LocalEnrollment, enrollApplication } from "./enroll.js";
import type { OwnerDecisionContext } from "./versions.js";

export const PublicPreviewEnrollment = LocalEnrollment.extend({
  auth_mode: z.literal("none"),
  network_policy: z.enum(["public_ipv4_pinned", "provider_verified_vercel"]),
  source: Version.shape.source.extend({ repo_id: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/) }).strict(),
  parent_version_id: Version.shape.version_id,
  deployment_id: z.string().regex(/^dpl_[A-Za-z0-9]+$/),
  project_id: z.string().regex(/^prj_[A-Za-z0-9]+$/),
  team_id: z.string().regex(/^team_[A-Za-z0-9]+$/),
  tools: z.array(z.string().min(1).max(128)).min(1).max(1000).refine((tools) => new Set(tools).size === tools.length),
}).strict();

type Input = z.infer<typeof PublicPreviewEnrollment>;
export interface PreviewProviderReader { read(route: string, teamId: string): Promise<unknown> }

/** Existing authenticated CLI only. No login, token extraction, deployment, project linking or mutation. */
export function vercelCliReader(options: { executable: string; dataDirectory: string; cacheDirectory: string; executablePath: string }): PreviewProviderReader {
  for (const value of [options.executable, options.dataDirectory, options.cacheDirectory]) {
    if (!path.isAbsolute(value)) throw new Error("Vercel CLI and its explicit runtime directories must be absolute paths.");
  }
  const networkEnvironment = Object.fromEntries(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS"]
    .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  return { async read(route, teamId) {
    try {
      const result = await promisify(execFile)(options.executable,
        ["api", route, "--scope", teamId, "--method", "GET", "--raw"],
        { env: { ...networkEnvironment, PATH: options.executablePath, HOME: "/nonexistent", XDG_DATA_HOME: options.dataDirectory,
          XDG_CACHE_HOME: options.cacheDirectory, VERCEL_TELEMETRY_DISABLED: "1", NO_UPDATE_NOTIFIER: "1", CI: "1" },
          timeout: 30_000, maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout) as unknown;
    } catch { throw new FlywheelError("operation_unavailable", "Vercel read-only verification failed; check the existing CLI login and exact project access. Provider output is withheld."); }
  } };
}

/** Metadata is read live from Vercel; caller-supplied JSON is never a provider attestation. */
export async function verifyPublicPreview(input: Input, provider: PreviewProviderReader) {
  const deployment = z.object({ id: z.string(), url: z.string(), projectId: z.string(), ownerId: z.string().optional(), team: z.object({ id: z.string() }).passthrough(),
    readyState: z.literal("READY"), target: z.union([z.literal("preview"), z.null()]),
    customEnvironment: z.unknown().nullish(), meta: z.record(z.string(), z.unknown()),
    gitSource: z.object({ type: z.literal("github"), sha: z.string(), repoId: z.union([z.string(), z.number()]) }).passthrough().nullish(),
  }).safeParse(await provider.read(`/v13/deployments/${encodeURIComponent(input.deployment_id)}`, input.team_id));
  if (!deployment.success) throw new FlywheelError("version_unavailable", "Provider did not confirm a ready preview deployment.");
  const data = deployment.data;
  if (data.id !== input.deployment_id || data.projectId !== input.project_id || data.team.id !== input.team_id || (data.ownerId !== undefined && data.ownerId !== input.team_id) || data.customEnvironment != null
      || !/^[A-Za-z0-9-]+\.vercel\.app$/.test(data.url)) {
    throw new FlywheelError("forbidden", "Provider deployment identity, project, team or preview target does not match.");
  }
  const url = new URL(input.url);
  if (url.href !== input.url || url.origin !== `https://${data.url}` || url.username || url.password || url.search || url.hash || url.port) {
    throw new FlywheelError("forbidden", "Use the exact provider-returned immutable HTTPS deployment URL and MCP path, without credentials, query or fragment.");
  }
  const project = z.object({ id: z.string(), accountId: z.string(), link: z.object({
    type: z.literal("github"), org: z.string(), repo: z.string(), repoId: z.union([z.string(), z.number()]),
  }).passthrough() }).safeParse(await provider.read(`/v9/projects/${encodeURIComponent(input.project_id)}`, input.team_id));
  if (!project.success || project.data.id !== input.project_id || project.data.accountId !== input.team_id
      || `${project.data.link.org}/${project.data.link.repo}` !== input.source.repo_id) {
    throw new FlywheelError("forbidden", "The provider project must be linked to the exact owner-configured source repository.");
  }
  // CLI metadata records the owner's exact committed upload assertion, not a Git-provider build proof.
  let sourceVerification: "provider_git" | "owner_metadata";
  if (data.gitSource?.sha === input.source.commit_sha && String(data.gitSource.repoId) === String(project.data.link.repoId) && data.meta.githubCommitSha === input.source.commit_sha
      && `${data.meta.githubCommitOrg}/${data.meta.githubCommitRepo}` === input.source.repo_id) sourceVerification = "provider_git";
  else if (data.gitSource == null && data.meta.tooltunerCommitSha === input.source.commit_sha && data.meta.tooltunerRepoId === input.source.repo_id) sourceVerification = "owner_metadata";
  else throw new FlywheelError("forbidden", "Provider source metadata does not match the exact source commit and repository.");
  return { mode: "public" as const, provider: "vercel" as const, network_policy: input.network_policy, project_id: input.project_id,
    team_id: input.team_id, source_verification: sourceVerification };
}

export async function enrollPublicPreview(db: GraphClient, owner: OwnerDecisionContext, raw: unknown, provider: PreviewProviderReader) {
  if (!owner.owner_id || !owner.subject) throw new FlywheelError("forbidden", "Public preview enrollment requires the trusted owner context.");
  const input = PublicPreviewEnrollment.parse(raw);
  if (input.application === "flywheel") throw new FlywheelError("forbidden", "The builtin application cannot be enrolled.");
  const parent = await getVersion(db, owner.owner_id, input.application, input.parent_version_id);
  if (!parent || parent.owner_id !== owner.owner_id || parent.application !== input.application || parent.version_id !== input.parent_version_id || parent.source.repo_id !== input.source.repo_id) {
    throw new FlywheelError("forbidden", "The exact parent must belong to this owner, application and source repository.");
  }
  const public_access = await verifyPublicPreview(input, provider);
  return enrollApplication(db, owner, input, {
    owner_id: owner.owner_id, application: input.application, source: input.source,
    runtime_target: { kind: "mcp_streamable_http", url: input.url, deployment_id: input.deployment_id, environment: "preview" },
    auth_config_ref: null, public_access,
  });
}
