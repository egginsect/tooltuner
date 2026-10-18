/** Owner-only enrollment for local anonymous and explicitly linked protected MCP applications. */
import { z } from "zod";
import {
  Application, Version, COMPLETE, FlywheelError, canonicalDigest, provenanceOf,
} from "../contracts.js";
import {
  CredentialBinding, getApplication, getVersion, getCredentialBinding, getUpstreamAccount,
  insertApplication, insertVersion, versionDigest,
} from "../db/registry.js";
import type { GraphClient } from "../db/client.js";
import { readUpstreamCatalog, type UpstreamOptions, type UpstreamTarget } from "../gateway/upstream.js";
import type { CredentialMediator } from "../gateway/credentials.js";
import { validateToolArgs } from "../gateway/registry.js";
import type { OwnerDecisionContext } from "./versions.js";

const SelectedTools = z.array(z.string().min(1).max(128)).min(1).max(1000)
  .refine((names) => new Set(names).size === names.length, "Tool names must be unique");

export const LocalEnrollment = z.object({
  application: Application.shape.application,
  description: z.string().min(1),
  label: Version.shape.label,
  source: Version.shape.source.strict(),
  url: z.string().url(),
  deployment_id: z.string().min(1),
  parent_version_id: Version.shape.parent_version_id.default(null),
  tools: SelectedTools.optional(),
}).strict();

/** Remote capabilities must be selected explicitly, independently of OAuth scopes or later grants. */
export const RemoteEnrollment = LocalEnrollment.extend({
  source: Version.shape.source.extend({ repo_id: z.string().min(1) }).strict(),
  environment: z.enum(["preview", "production"]),
  auth_config_ref: CredentialBinding.shape.auth_config_ref,
  tools: SelectedTools,
}).strict();

export interface RemoteEnrollmentOptions {
  credentials: Pick<CredentialMediator, "resolveAuth">;
  timeoutMs?: number;
}

/** No stable-pointer change, upstream credential, or application-specific tool knowledge. */
export async function enrollLocalApplication(
  db: GraphClient, owner: OwnerDecisionContext, rawInput: unknown,
) {
  if (!owner.owner_id || !owner.subject) throw new FlywheelError("forbidden", "Local enrollment requires the trusted owner context.");
  const input = LocalEnrollment.parse(rawInput);
  if (input.application === "flywheel") throw new FlywheelError("forbidden", "The builtin application cannot be enrolled.");
  const url = new URL(input.url);
  // Literal loopback only: no hostname resolution, redirects, URL credentials or query secrets.
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw new FlywheelError("invalid_args", "Local enrollment requires a credential-free literal loopback HTTP MCP URL without query or fragment.");
  }
  return enrollApplication(db, owner, input, {
    owner_id: owner.owner_id, application: input.application, source: input.source,
    runtime_target: { kind: "mcp_streamable_http", url: url.href,
      deployment_id: input.deployment_id, environment: "local" },
    auth_config_ref: null,
  });
}

/** Link first: enrollment only consumes an already persisted exact credential authority. */
export async function enrollRemoteApplication(
  db: GraphClient, owner: OwnerDecisionContext, rawInput: unknown, options: RemoteEnrollmentOptions,
) {
  if (!owner.owner_id || !owner.subject) throw new FlywheelError("forbidden", "Remote enrollment requires the trusted owner context.");
  const input = RemoteEnrollment.parse(rawInput);
  if (input.application === "flywheel") throw new FlywheelError("forbidden", "The builtin application cannot be enrolled.");
  const url = new URL(input.url);
  // Do not normalize a different spelling into an approved binding or accept embedded credentials.
  if (url.protocol !== "https:" || url.username || url.password || input.url.includes("?") || input.url.includes("#") || url.href !== input.url) {
    throw new FlywheelError("invalid_args", "Remote enrollment requires an exact canonical credential-free HTTPS MCP URL without query or fragment.");
  }
  if (typeof options?.credentials?.resolveAuth !== "function") {
    throw new FlywheelError("operation_unavailable", "Remote enrollment requires the configured upstream credential mediator.");
  }
  const binding = await getCredentialBinding(db, owner.owner_id, input.auth_config_ref, input.url);
  const account = await getUpstreamAccount(db, owner.owner_id, input.auth_config_ref);
  // Validate returned document identities too; lookup keys alone are not an authorization proof.
  // Every check precedes credential resolution, initialize, and listTools network activity.
  if (!binding || !account ||
      binding.owner_id !== owner.owner_id || binding.auth_config_ref !== input.auth_config_ref ||
      binding.application !== input.application || binding.repo_id !== input.source.repo_id ||
      binding.commit_sha !== input.source.commit_sha || binding.deployment_id !== input.deployment_id ||
      binding.environment !== input.environment || binding.url !== input.url ||
      account.owner_id !== owner.owner_id || account.auth_config_ref !== input.auth_config_ref ||
      account.application !== input.application || account.repo_id !== input.source.repo_id ||
      account.environment !== input.environment || account.issuer !== binding.issuer ||
      binding.scopes.some((scope) => !account.scopes.includes(scope))) {
    throw new FlywheelError("forbidden", "Remote enrollment requires a linked account and persisted credential binding for this exact owner, application, source, deployment and authority.");
  }
  return enrollApplication(db, owner, input, {
    owner_id: owner.owner_id, application: input.application, source: input.source,
    runtime_target: { kind: "mcp_streamable_http", url: input.url,
      deployment_id: input.deployment_id, environment: input.environment },
    auth_config_ref: input.auth_config_ref,
  }, { timeoutMs: options.timeoutMs, resolveAuth: (reference, target) => options.credentials.resolveAuth(reference, target) });
}

/** Shared immutable registration path; never changes STABLE, grants, accounts or bindings. */
export async function enrollApplication(
  db: GraphClient, owner: OwnerDecisionContext, input: z.infer<typeof LocalEnrollment>,
  target: Omit<UpstreamTarget, "version_id">, options: UpstreamOptions = {},
) {
  const priorApp = await getApplication(db, owner.owner_id, input.application);
  if (priorApp && (priorApp.kind !== "upstream" || priorApp.description !== input.description)) {
    throw new FlywheelError("ingest_conflict", "Application metadata differs from its existing registration.");
  }
  if (input.parent_version_id) {
    const parent = await getVersion(db, owner.owner_id, input.application, input.parent_version_id);
    if (!parent || parent.owner_id !== owner.owner_id || parent.application !== input.application || parent.version_id !== input.parent_version_id || parent.source.repo_id !== input.source.repo_id) {
      throw new FlywheelError("version_unavailable", "The exact parent must exist in this owner application and source repository.");
    }
  }
  const identity = canonicalDigest({ ...target, parent_version_id: input.parent_version_id, label: input.label });
  const version_id = `ver_${identity.slice(7, 33)}`;
  // Live initialize/listTools only; enrollment never invokes an upstream business tool.
  const catalog = await readUpstreamCatalog({ ...target, version_id }, options);
  if (!catalog.length || new Set(catalog.map((tool) => tool.name)).size !== catalog.length) {
    throw new FlywheelError("version_unavailable", "The live catalog must contain at least one uniquely named tool.");
  }
  if (input.tools?.some((name) => !catalog.some((tool) => tool.name === name))) {
    throw new FlywheelError("invalid_args", "Every selected tool must exist in the live upstream catalog.");
  }
  // An explicit subset bounds the enrolled capability surface; grants still enforce access.
  const tools = input.tools ? catalog.filter((tool) => input.tools!.includes(tool.name)) : catalog;
  for (const tool of tools) {
    try { validateToolArgs(tool, {}); }
    catch (error) { if (!(error instanceof FlywheelError) || error.shape.code !== "invalid_args") throw error; }
  }
  const metadata = { schema_version: 1 as const, owner_id: owner.owner_id, created_at: new Date().toISOString(),
    provenance: { ...provenanceOf("owner_cli", null), subject: owner.subject }, completeness: COMPLETE };
  const content = { ...metadata, ...target, version_id, label: input.label, parent_version_id: input.parent_version_id,
    tools, schema_digest: canonicalDigest({ tools }),
    // Source/deployment identity is an explicit owner assertion, not a provider attestation.
    verified_provenance: { method: "owner_config" as const, job_id: null, packet_id: null },
    state: "ready" as const,
    readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: target.public_access === undefined } };
  const version = Version.parse({ ...content, digest: versionDigest(content) });
  const prior = await getVersion(db, owner.owner_id, input.application, input.label);
  if (prior && (prior.version_id !== version_id || prior.digest !== version.digest)) {
    throw new FlywheelError("ingest_conflict", "This label has different immutable source, target or catalog content; use a new version label.");
  }
  if (!priorApp) {
    try { await insertApplication(db, { ...metadata, application: input.application, description: input.description, kind: "upstream" }); }
    catch (error) {
      if (!(error instanceof FlywheelError) || error.shape.code !== "ingest_conflict") throw error;
      const concurrent = await getApplication(db, owner.owner_id, input.application);
      if (!concurrent || concurrent.kind !== "upstream" || concurrent.description !== input.description) throw error;
    }
  }
  let saved = prior;
  if (!saved) {
    try { saved = await insertVersion(db, version); }
    catch (error) {
      // Reconcile only a known immutable conflict, never retry an uncertain storage write.
      if (!(error instanceof FlywheelError) || error.shape.code !== "ingest_conflict") throw error;
      const concurrent = await getVersion(db, owner.owner_id, input.application, input.label);
      if (!concurrent || concurrent.version_id !== version_id || concurrent.digest !== version.digest) throw error;
      saved = concurrent;
    }
  }
  return { application: saved.application, version_id: saved.version_id, label: saved.label,
    schema_digest: saved.schema_digest, tool_count: saved.tools.length, stable_changed: false };
}
