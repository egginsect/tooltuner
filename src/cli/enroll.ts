/** Owner-only enrollment for anonymous, isolated loopback MCP applications. */
import { z } from "zod";
import {
  Application, Version, COMPLETE, FlywheelError, canonicalDigest, provenanceOf,
} from "../contracts.js";
import {
  getApplication, getVersion, insertApplication, insertVersion, versionDigest,
} from "../db/registry.js";
import type { GraphClient } from "../db/client.js";
import { readUpstreamCatalog } from "../gateway/upstream.js";
import { validateToolArgs } from "../gateway/registry.js";
import type { OwnerDecisionContext } from "./versions.js";

export const LocalEnrollment = z.object({
  application: Application.shape.application,
  description: z.string().min(1),
  label: Version.shape.label,
  source: Version.shape.source.strict(),
  url: z.string().url(),
  deployment_id: z.string().min(1),
  parent_version_id: Version.shape.parent_version_id.default(null),
  tools: z.array(z.string().min(1).max(128)).min(1).max(1000)
    .refine((names) => new Set(names).size === names.length, "Tool names must be unique").optional(),
}).strict();

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
  const priorApp = await getApplication(db, owner.owner_id, input.application);
  if (priorApp && (priorApp.kind !== "upstream" || priorApp.description !== input.description)) {
    throw new FlywheelError("ingest_conflict", "Application metadata differs from its existing registration.");
  }
  if (input.parent_version_id) {
    const parent = await getVersion(db, owner.owner_id, input.application, input.parent_version_id);
    if (!parent || parent.version_id !== input.parent_version_id || parent.source.repo_id !== input.source.repo_id) {
      throw new FlywheelError("version_unavailable", "The exact parent must exist in this owner application and source repository.");
    }
  }
  const runtime_target = { kind: "mcp_streamable_http" as const, url: url.href,
    deployment_id: input.deployment_id, environment: "local" as const };
  const target = { owner_id: owner.owner_id, application: input.application, source: input.source,
    runtime_target, auth_config_ref: null };
  const identity = canonicalDigest({ ...target, parent_version_id: input.parent_version_id, label: input.label });
  const version_id = `ver_${identity.slice(7, 33)}`;
  // Live initialize/listTools only; enrollment never invokes an upstream business tool.
  const catalog = await readUpstreamCatalog({ ...target, version_id });
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
    readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
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
