import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import {
  COMPLETE, FLYWHEEL_APP, FLYWHEEL_OPERATIONS, FlywheelError, canonicalDigest,
  Job, Packet, InnerTool as InnerToolSchema, Sha, Digest, Timestamp, provenanceOf,
  type DescribeOutput, type FlywheelHandlers, type InnerTool, type Version,
  type OperationContext, type RegisterPreviewOutput,
} from "../contracts.js";
import { getApplication, getStable, getVersion, assertVersionReady, insertVersion, versionDigest } from "../db/registry.js";
import type { GraphClient } from "../db/client.js";
import { canUseTool, visibleFlywheelOperations, assertAppInScope, assertRepoAllowed } from "../policy.js";
import type { GatewayContext } from "./mcp.js";

export const BUILTIN_VERSION = "builtin-v1";

export function assertContext(ctx: GatewayContext): void {
  if (ctx.principal.owner_id !== ctx.grant.owner_id || ctx.principal.grant_id !== ctx.grant.grant_id || ctx.grant.revoked_at !== null) {
    throw new FlywheelError("forbidden", "The verified principal and active grant must belong to the same owner and grant.");
  }
}

/** User group and at least one tool in the allowlist are required for upstream discovery. */
export function upstreamVisible(ctx: GatewayContext, application: string): boolean {
  const tools = ctx.grant.allow.tools[application];
  return ctx.grant.groups.includes("user") && (tools === undefined
    ? canUseTool(ctx.grant, application, "__catalog__")
    : tools.some((tool) => canUseTool(ctx.grant, application, tool)));
}

export async function resolveVersion(db: GraphClient, owner: string, application: string, selector?: string): Promise<Version> {
  if (!await getApplication(db, owner, application)) throw new FlywheelError("not_found", "Application was not found.", { fieldPath: "application" });
  // Resolve the mutable pointer exactly once. Every later action uses this immutable snapshot.
  const resolved = selector ?? (await getStable(db, owner, application))?.version_id;
  const version = resolved ? await getVersion(db, owner, application, resolved) : null;
  if (!version) throw new FlywheelError("version_unavailable", "The exact selected version is unavailable; no fallback is allowed.", { fieldPath: "version" });
  assertVersionReady(version);
  return version;
}

export function builtinDescription(ctx: GatewayContext, handlers: FlywheelHandlers, selector?: string): DescribeOutput {
  if (selector !== undefined && selector !== BUILTIN_VERSION && selector !== "v1") throw new FlywheelError("version_unavailable", "The selected builtin version is unavailable.", { fieldPath: "version" });
  const catalog: InnerTool[] = Object.entries(FLYWHEEL_OPERATIONS).map(([name, op]) => ({
    name, description: op.description, input_schema: z.toJSONSchema(op.input), effects: op.effects,
  }));
  const visible = new Set(visibleFlywheelOperations(ctx.grant, handlers));
  return { application: FLYWHEEL_APP, resolved_version: BUILTIN_VERSION, schema_digest: canonicalDigest({ tools: catalog }),
    tools: catalog.filter((tool) => visible.has(tool.name as keyof typeof FLYWHEEL_OPERATIONS)) };
}

/** A fresh SDK validator per schema prevents cross-version $id cache aliasing. */
export function validateToolArgs(tool: InnerTool, args: Record<string, unknown>): void {
  let check;
  try {
    // The SDK's default Ajv targets draft-7; modern MCP and zod catalogs use 2020-12.
    const dialect = tool.input_schema["$schema"];
    const modern = dialect === undefined || (typeof dialect === "string" && dialect.includes("2020-12"));
    const ajv = modern ? new Ajv2020({ strict: false, allErrors: true }) : undefined;
    if (ajv) (addFormats as unknown as (instance: Ajv2020) => void)(ajv);
    check = new AjvJsonSchemaValidator(ajv).getValidator(tool.input_schema);
  }
  catch { throw new FlywheelError("version_unavailable", "The selected version contains an invalid JSON Schema.", { fieldPath: "version" }); }
  const result = check(args);
  if (!result.valid) throw new FlywheelError("invalid_args", result.errorMessage, { fieldPath: "args" });
}

export const catalogCompleteness = () => ({ ...COMPLETE, missing_refs: [], notes: [] });

export interface PreviewRegistryProject {
  owner_id: string;
  application: string;
  repo_id: string;
  project_id: string;
  team_id: string;
}

export interface PreviewRegistryOptions {
  db: GraphClient;
  projects: readonly PreviewRegistryProject[];
}

// Private adapter-boundary check. Version, Job and Packet remain the frozen domain records.
const Verification = z.object({
  owner_id: z.string(), application: z.string(), repo_id: z.string(), job_id: z.string(), packet_id: z.string(),
  commit_sha: Sha, artifact_digest: Digest, deployment_id: z.string().min(1), project_id: z.string().min(1), team_id: z.string().min(1),
  url: z.string().url(), target: z.literal("preview"), ready_at: Timestamp,
  tools: z.array(InnerToolSchema), schema_digest: Digest, auth_config_ref: z.string().min(1),
  checks: z.object({ deployment_ready: z.literal(true), provenance_verified: z.literal(true), schema_verified: z.literal(true), auth_verified: z.literal(true) }),
});

/** Inject into the trusted job coordinator only. It never deploys or changes STABLE. */
export function createPreviewRegistry(options: PreviewRegistryOptions): {
  registerPreview(ctx: OperationContext, job: Job, packet: Packet, verification: unknown): Promise<z.infer<typeof RegisterPreviewOutput>>;
} {
  return { async registerPreview(ctx, rawJob, rawPacket, verification) {
    assertContext(ctx);
    const job = Job.parse(rawJob), packet = Packet.parse(rawPacket);
    if (!ctx.grant.groups.includes("management") || ctx.grant.scope.job_id || ctx.grant.scope.packet_id) throw new FlywheelError("forbidden", "Preview registration requires the trusted management coordinator.");
    assertAppInScope(ctx.grant, job.application);
    assertRepoAllowed(ctx.grant, job.repo_id);
    const parsed = Verification.safeParse(verification);
    if (!parsed.success) throw new FlywheelError("version_unavailable", "Preview registration requires complete manager verification receipts.");
    const verified = parsed.data;
    const project = options.projects.find((p) => p.owner_id === ctx.principal.owner_id && p.application === job.application && p.repo_id === job.repo_id);
    if (!project) throw new FlywheelError("operation_unavailable", "No trusted preview project is configured for this owner/application/repository.");
    if (job.owner_id !== ctx.principal.owner_id || packet.owner_id !== job.owner_id || packet.application !== job.application ||
        packet.packet_id !== job.packet_id || packet.source.repo_id !== job.repo_id || packet.source.commit_sha !== job.base_sha ||
        job.state !== "completed" || !job.result || !job.deployment ||
        verified.owner_id !== job.owner_id || verified.application !== job.application || verified.repo_id !== job.repo_id ||
        verified.job_id !== job.job_id || verified.packet_id !== packet.packet_id ||
        verified.commit_sha !== job.result.commit_sha || verified.artifact_digest !== job.result.artifact_ref ||
        verified.deployment_id !== job.deployment.deployment_id || verified.url !== job.deployment.url ||
        verified.commit_sha !== job.deployment.commit_sha || verified.project_id !== job.deployment.project_id ||
        verified.project_id !== project.project_id || verified.team_id !== project.team_id ||
        verified.schema_digest !== canonicalDigest({ tools: verified.tools })) {
      throw new FlywheelError("forbidden", "Verified preview does not match the owner, packet, artifact and configured deployment authority.");
    }
    const targetUrl = new URL(verified.url);
    if (targetUrl.protocol !== "https:" || targetUrl.username || targetUrl.password || targetUrl.search || targetUrl.hash) {
      throw new FlywheelError("forbidden", "A preview must use its verified credential-free HTTPS deployment URL.");
    }
    const parent = await getVersion(options.db, job.owner_id, job.application, packet.parent_version_id);
    if (!parent || parent.source.repo_id !== job.repo_id) throw new FlywheelError("version_unavailable", "The preview's immutable parent is not registered in this owner application/repository.");
    for (const tool of verified.tools) {
      try { validateToolArgs(tool, {}); }
      catch (error) { if (!(error instanceof FlywheelError) || error.shape.code !== "invalid_args") throw error; }
    }
    const identity = canonicalDigest({ owner: job.owner_id, application: job.application, job_id: job.job_id }).slice(7, 33);
    const content = {
      schema_version: 1 as const, owner_id: job.owner_id, created_at: verified.ready_at,
      provenance: { ...provenanceOf("manager", null), ...job.provenance, recorded_by: "manager" as const }, completeness: COMPLETE,
      version_id: `ver_${identity}`, application: job.application, label: `preview-${identity.slice(0, 16)}`,
      parent_version_id: parent.version_id, source: { repo_id: job.repo_id, commit_sha: verified.commit_sha }, tools: verified.tools,
      schema_digest: verified.schema_digest, runtime_target: { kind: "mcp_streamable_http" as const, url: verified.url,
        deployment_id: verified.deployment_id, environment: "preview" as const }, auth_config_ref: verified.auth_config_ref,
      verified_provenance: { method: "manager_verified" as const, job_id: job.job_id, packet_id: packet.packet_id }, state: "ready" as const, readiness: verified.checks,
    };
    const version = await insertVersion(options.db, { ...content, digest: versionDigest(content) });
    return { version_id: version.version_id, state: version.state, missing_checks: [] };
  } };
}
