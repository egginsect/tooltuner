import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  Application, Version, FlywheelError, COMPLETE, canonicalDigest, provenanceOf,
  type Application as ApplicationRecord, type Version as VersionRecord,
} from "../src/contracts.js";
import { getApplication, getStable, getVersion, insertApplication, insertVersion, seedInitialStable, versionDigest } from "../src/db/registry.js";
import type { GraphClient } from "../src/db/client.js";
import { readUpstreamCatalog, type UpstreamOptions, type UpstreamTarget } from "../src/gateway/upstream.js";
import { validateToolArgs } from "../src/gateway/registry.js";

export interface FixtureSeedOptions extends UpstreamOptions {
  owner_id: string;
  baseUrl: string;
  /** Explicit owner assertion of this fixture checkout's exact repository and full commit. */
  source: VersionRecord["source"];
  initializeStable?: boolean;
}

const Config = z.object({ applications: z.array(z.object({ application: z.string(), description: z.string(), path: z.string(), label: z.literal("v1") })) });

/** Probes real MCP catalogs before persisting owner-configured local v1 seeds. No implicit boot seeding. */
export async function seedConfiguredFixtures(db: GraphClient, options: FixtureSeedOptions): Promise<{ applications: ApplicationRecord[]; versions: VersionRecord[] }> {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) || base.username || base.password) {
    throw new FlywheelError("invalid_args", "Fixture seeds require a credential-free loopback HTTP origin.", { fieldPath: "baseUrl" });
  }
  const config = Config.parse(JSON.parse(await readFile(new URL("../config/fixtures.json", import.meta.url), "utf8")));
  const applications: ApplicationRecord[] = [];
  const versions: VersionRecord[] = [];
  for (const entry of config.applications) {
    const at = new Date().toISOString();
    const metadata = { schema_version: 1 as const, owner_id: options.owner_id, created_at: at, provenance: provenanceOf("seed", null), completeness: COMPLETE };
    const application = Application.parse({ ...metadata, application: entry.application, description: entry.description, kind: "upstream" });
    const runtime_target = { kind: "mcp_streamable_http" as const, url: new URL(entry.path, base).href, deployment_id: `local:${entry.application}:${entry.label}`, environment: "local" as const };
    const identity = canonicalDigest({ owner: options.owner_id, application: entry.application, source: options.source, runtime_target });
    const target: UpstreamTarget = { owner_id: options.owner_id, application: entry.application, source: options.source, runtime_target, auth_config_ref: null,
      version_id: `ver_${createHash("sha256").update(identity).digest("hex").slice(0, 26)}` };
    const tools = await readUpstreamCatalog(target, options);
    // Compile every live schema; validation failures on empty input are expected for required fields.
    for (const tool of tools) {
      try { validateToolArgs(tool, {}); }
      catch (error) { if (!(error instanceof FlywheelError) || error.shape.code !== "invalid_args") throw error; }
    }
    const content = { ...metadata, ...target, label: entry.label, parent_version_id: null, tools, schema_digest: canonicalDigest({ tools }),
      verified_provenance: { method: "owner_config" as const, job_id: null, packet_id: null }, state: "ready" as const,
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
    const version = Version.parse({ ...content, digest: versionDigest(content) });
    const priorApp = await getApplication(db, options.owner_id, entry.application);
    if (priorApp && (priorApp.kind !== application.kind || priorApp.description !== application.description)) throw new FlywheelError("ingest_conflict", "Configured fixture application conflicts with its stored registration.");
    applications.push(priorApp ?? await insertApplication(db, application));
    const prior = await getVersion(db, options.owner_id, entry.application, entry.label);
    if (prior && (prior.digest !== version.digest || prior.version_id !== version.version_id)) throw new FlywheelError("ingest_conflict", "Configured fixture differs from the immutable registered v1; use a new version.");
    const stored = prior ?? await insertVersion(db, version);
    versions.push(stored);
    if (options.initializeStable === true && !await getStable(db, options.owner_id, entry.application)) await seedInitialStable(db, stored);
  }
  return { applications, versions };
}
