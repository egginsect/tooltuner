import {
  Application, Version, StablePointer, HumanDecision, FlywheelError, canonicalDigest, canonicalJson,
  VERSION_DIGEST_FIELDS, READINESS_CHECKS,
  type Application as ApplicationRecord, type Version as VersionRecord,
  type HumanDecision as DecisionRecord, type StablePointer as PointerRecord,
} from "../contracts.js";
import { StorageError } from "../errors.js";
import type { GraphClient } from "./client.js";
import type { IndexSpec } from "./schema.js";
import { z } from "zod";

export const REGISTRY_INDEX_SPECS: readonly IndexSpec[] = [
  { label: "Application", property: "registry_key", unique: true },
  { label: "Application", property: "owner_id" },
  { label: "Version", property: "version_id", unique: true },
  { label: "Version", property: "registry_key", unique: true },
  { label: "HumanDecision", property: "decision_id", unique: true },
  { label: "UpstreamAccount", property: "registry_key", unique: true },
  { label: "UpstreamCredentialBinding", property: "registry_key", unique: true },
];

const appKey = (owner: string, application: string) => canonicalJson([owner, application]);
const labelKey = (v: VersionRecord) => canonicalJson([v.owner_id, v.application, v.label]);

/** Keep storage failures in the frozen error vocabulary without exposing driver details. */
export async function registryStorage<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof FlywheelError) throw error;
    if (error instanceof StorageError && error.code === "ingest_conflict") throw new FlywheelError("ingest_conflict", "The registry identity conflicts with an existing immutable record.");
    throw new FlywheelError("storage_unavailable", "Registry persistence failed; check FalkorDB before retrying.", {
      certainty: error instanceof StorageError ? error.outcomeCertainty : "unknown",
    });
  }
}

export function versionDigest(version: Pick<VersionRecord, (typeof VERSION_DIGEST_FIELDS)[number]>): string {
  return canonicalDigest(Object.fromEntries(VERSION_DIGEST_FIELDS.map((key) => [key, version[key]])));
}

export function validateVersion(input: VersionRecord): VersionRecord {
  const version = Version.parse(input);
  if (version.schema_digest !== canonicalDigest({ tools: version.tools }) || version.digest !== versionDigest(version)) {
    throw new FlywheelError("invalid_args", "Version or tool catalog digest does not match its immutable content.", { fieldPath: "digest" });
  }
  if (new Set(version.tools.map((t) => t.name)).size !== version.tools.length) {
    throw new FlywheelError("invalid_args", "Version tool names must be unique.", { fieldPath: "tools" });
  }
  return version;
}

export function assertVersionReady(version: VersionRecord): void {
  if (version.state !== "ready" || READINESS_CHECKS.some((key) => !version.readiness[key])) {
    throw new FlywheelError("version_unavailable", "The selected version has not passed all readiness checks.", { fieldPath: "version" });
  }
}

export async function insertApplication(db: GraphClient, input: ApplicationRecord): Promise<ApplicationRecord> {
  const app = Application.parse(input);
  if (app.application === "flywheel" || app.kind !== "upstream") throw new FlywheelError("forbidden", "The builtin flywheel application cannot be registered or replaced.");
  return registryStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MERGE (a:Application {registry_key: $key})
       ON CREATE SET a.application = $app, a.owner_id = $owner, a.created_at = $at, a.doc = $doc
       RETURN a.doc AS doc`,
      { key: appKey(app.owner_id, app.application), app: app.application, owner: app.owner_id, at: app.created_at, doc: canonicalJson(app) },
    );
    if (!rows[0] || rows[0].doc !== canonicalJson(app)) {
      throw new FlywheelError("ingest_conflict", "Application already exists with different content.");
    }
    return Application.parse(JSON.parse(rows[0].doc));
  });
}

export async function getApplication(db: GraphClient, owner: string, application: string): Promise<ApplicationRecord | null> {
  return registryStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>("MATCH (a:Application {registry_key: $key}) RETURN a.doc AS doc", { key: appKey(owner, application) });
    return rows[0] ? Application.parse(JSON.parse(rows[0].doc)) : null;
  });
}

export async function listApplications(db: GraphClient, owner: string): Promise<ApplicationRecord[]> {
  return registryStorage(async () => (await db.roQuery<{ doc: string }>(
    "MATCH (a:Application {owner_id: $owner}) RETURN a.doc AS doc ORDER BY a.application", { owner },
  )).map((row) => Application.parse(JSON.parse(row.doc))));
}

/** Insert only. Identity, label and full snapshot are immutable, including readiness. */
export async function insertVersion(db: GraphClient, input: VersionRecord): Promise<VersionRecord> {
  const version = validateVersion(input);
  if (version.application === "flywheel") throw new FlywheelError("forbidden", "The builtin flywheel catalog comes only from the frozen contracts.");
  return registryStorage(async () => {
    if (!await getApplication(db, version.owner_id, version.application)) throw new FlywheelError("not_found", "Register the application first.");
    if (version.parent_version_id && !await getVersion(db, version.owner_id, version.application, version.parent_version_id)) {
      throw new FlywheelError("version_unavailable", "The parent version is outside this application or does not exist.");
    }
    const rows = await db.query<{ doc: string }>(
      `MATCH (a:Application {registry_key: $appKey})
       OPTIONAL MATCH (existing:Version {version_id: $id})
       OPTIONAL MATCH (labelled:Version {registry_key: $key})
       OPTIONAL MATCH (parent:Version {version_id: $parent, owner_id: $owner, application: $app})
       WITH a, existing, labelled, parent WHERE existing IS NULL AND labelled IS NULL AND ($parent IS NULL OR parent IS NOT NULL)
       CREATE (v:Version {version_id: $id, registry_key: $key, owner_id: $owner,
                         application: $app, created_at: $at, state: $state, doc: $doc})
       CREATE (a)-[:HAS_VERSION]->(v)
       FOREACH (p IN CASE WHEN parent IS NULL THEN [] ELSE [parent] END | CREATE (v)-[:DERIVED_FROM]->(p))
       RETURN v.doc AS doc`,
      { appKey: appKey(version.owner_id, version.application), key: labelKey(version), id: version.version_id,
        owner: version.owner_id, app: version.application, parent: version.parent_version_id, at: version.created_at, state: version.state, doc: canonicalJson(version) },
    );
    if (!rows[0]) {
      const existing = await getVersion(db, version.owner_id, version.application, version.version_id);
      if (!existing || canonicalJson(existing) !== canonicalJson(version)) throw new FlywheelError("ingest_conflict", "Version id or application label already has different immutable content.");
    }
    return version;
  });
}

export async function getVersion(db: GraphClient, owner: string, application: string, selector: string): Promise<VersionRecord | null> {
  return registryStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>(
      `MATCH (a:Application {registry_key: $key})-[:HAS_VERSION]->(v:Version)
       WHERE v.owner_id = $owner AND (v.version_id = $selector OR v.registry_key = $label)
       RETURN v.doc AS doc`,
      { key: appKey(owner, application), owner, selector, label: canonicalJson([owner, application, selector]) },
    );
    return rows[0] ? validateVersion(Version.parse(JSON.parse(rows[0].doc))) : null;
  });
}

export async function getStable(db: GraphClient, owner: string, application: string): Promise<PointerRecord | null> {
  return registryStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>(
      "MATCH (a:Application {registry_key: $key}) WHERE a.stable_doc IS NOT NULL RETURN a.stable_doc AS doc", { key: appKey(owner, application) },
    );
    return rows[0] ? StablePointer.parse(JSON.parse(rows[0].doc)) : null;
  });
}

/** One query both records the human decision and changes STABLE, guarded by expected current. */
export async function recordDecision(db: GraphClient, input: DecisionRecord): Promise<DecisionRecord> {
  const decision = HumanDecision.parse(input);
  if (decision.provenance.recorded_by !== "owner_cli") throw new FlywheelError("forbidden", "Human decisions require the owner CLI.");
  const key = appKey(decision.owner_id, decision.application);
  return registryStorage(async () => {
    const prior = await db.roQuery<{ doc: string }>("MATCH (d:HumanDecision {decision_id: $id}) RETURN d.doc AS doc", { id: decision.decision_id });
    if (prior[0]) {
      if (prior[0].doc !== canonicalJson(decision)) throw new FlywheelError("ingest_conflict", "Decision id already has different content.");
      return HumanDecision.parse(JSON.parse(prior[0].doc));
    }
    if (!await getApplication(db, decision.owner_id, decision.application)) throw new FlywheelError("not_found", "Application was not found.");
    const selected = decision.selected_version_id;
    if (selected !== null) {
      const version = await getVersion(db, decision.owner_id, decision.application, selected);
      if (!version) throw new FlywheelError("version_unavailable", "Selected version was not found in this owner application.");
      if (decision.kind !== "merge") assertVersionReady(version);
    }
    if (decision.kind !== "merge" && selected === null) throw new FlywheelError("invalid_args", "Activation and rollback require a selected version.", { fieldPath: "selected_version_id" });
    if (decision.kind === "merge" && decision.source === null) throw new FlywheelError("invalid_args", "A merge receipt requires a source commit.", { fieldPath: "source" });
    const params = { key, owner: decision.owner_id, id: decision.decision_id, at: decision.created_at,
      app: decision.application, selected, expected: decision.expected_current_version_id, doc: canonicalJson(decision),
      pointer: selected === null ? "" : canonicalJson(StablePointer.parse({ application: decision.application, version_id: selected, decision_id: decision.decision_id, updated_at: decision.created_at })) };
    const rows = decision.kind === "merge"
      ? await db.query<{ doc: string }>(
        `MATCH (a:Application {registry_key: $key})
         WHERE a.stable_version_id = $expected OR (a.stable_version_id IS NULL AND $expected IS NULL)
         OPTIONAL MATCH (a)-[:HAS_VERSION]->(selected:Version {version_id: $selected, owner_id: $owner})
         OPTIONAL MATCH (a)-[:HAS_VERSION]->(expected:Version {version_id: $expected, owner_id: $owner})
         CREATE (d:HumanDecision {decision_id: $id, owner_id: $owner, application: $app, created_at: $at, doc: $doc})
         FOREACH (v IN CASE WHEN selected IS NULL THEN [] ELSE [selected] END | CREATE (d)-[:SELECTED]->(v))
         FOREACH (v IN CASE WHEN expected IS NULL THEN [] ELSE [expected] END | CREATE (d)-[:EXPECTED_CURRENT]->(v))
         RETURN d.doc AS doc`, params)
      : await db.query<{ doc: string }>(
        `MATCH (a:Application {registry_key: $key})-[:HAS_VERSION]->(v:Version {version_id: $selected, owner_id: $owner})
         WHERE a.stable_version_id = $expected OR (a.stable_version_id IS NULL AND $expected IS NULL)
         OPTIONAL MATCH (a)-[:HAS_VERSION]->(expected:Version {version_id: $expected, owner_id: $owner})
         OPTIONAL MATCH (a)-[old:STABLE]->(:Version)
         DELETE old
         SET a.stable_version_id = $selected, a.stable_doc = $pointer
         CREATE (a)-[:STABLE]->(v)
         CREATE (d:HumanDecision {decision_id: $id, owner_id: $owner, application: $app, created_at: $at, doc: $doc})
         CREATE (d)-[:SELECTED]->(v)
         FOREACH (e IN CASE WHEN expected IS NULL THEN [] ELSE [expected] END | CREATE (d)-[:EXPECTED_CURRENT]->(e))
         RETURN d.doc AS doc`, params);
    if (!rows[0]) throw new FlywheelError("stale_expected_current", "Stable changed; review the current version before making another decision.");
    return HumanDecision.parse(JSON.parse(rows[0].doc));
  });
}

/** Explicit owner-configured v1 bootstrap only; never called by the gateway factory. */
export async function seedInitialStable(db: GraphClient, input: VersionRecord): Promise<PointerRecord> {
  const version = validateVersion(input);
  if (version.label !== "v1" || version.verified_provenance.method !== "owner_config" || version.provenance.recorded_by !== "seed") {
    throw new FlywheelError("forbidden", "Only an explicit owner-configured seed v1 can initialize stable.");
  }
  assertVersionReady(version);
  const stored = await getVersion(db, version.owner_id, version.application, version.version_id);
  if (!stored || canonicalJson(stored) !== canonicalJson(version)) throw new FlywheelError("version_unavailable", "Persist the exact seed version before initializing stable.");
  const pointer = StablePointer.parse({ application: version.application, version_id: version.version_id, decision_id: null, updated_at: version.created_at });
  return registryStorage(async () => {
    await db.query(
      `MATCH (a:Application {registry_key: $key})-[:HAS_VERSION]->(v:Version {version_id: $id})
       WHERE a.stable_version_id IS NULL
       SET a.stable_version_id = $id, a.stable_doc = $doc CREATE (a)-[:STABLE]->(v)`,
      { key: appKey(version.owner_id, version.application), id: version.version_id, doc: canonicalJson(pointer) },
    );
    const current = await getStable(db, version.owner_id, version.application);
    if (!current || current.version_id !== version.version_id) throw new FlywheelError("stale_expected_current", "An existing stable version cannot be replaced by a seed.");
    return current;
  });
}

const SafeReference = z.string().regex(/^[a-zA-Z][a-zA-Z0-9:._/-]{2,199}$/);
const Scopes = z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).min(1).max(30)
  .refine((values) => new Set(values).size === values.length, "Scopes must be unique").transform((values) => values.sort());

/** Internal authentication metadata only. Token material belongs in the external credential store. */
export const UpstreamAccount = z.object({
  schema_version: z.literal(1), owner_id: z.string().min(1), created_at: z.string().datetime({ offset: true }),
  auth_config_ref: SafeReference, credential_ref: SafeReference, application: Application.shape.application,
  repo_id: z.string().min(1), environment: z.enum(["local", "preview", "production"]),
  issuer: z.string().url(), introspection_url: z.string().url().optional(),
  validation_mode: z.enum(["introspection", "standard_oauth"]).optional(), client_id: z.string().min(1).max(200), scopes: Scopes,
}).strict();
export type UpstreamAccount = z.infer<typeof UpstreamAccount>;

/** One exact approved resource/deployment binding, reusable by all versions of that immutable target. */
export const CredentialBinding = z.object({
  schema_version: z.literal(1), owner_id: z.string().min(1), created_at: z.string().datetime({ offset: true }),
  auth_config_ref: SafeReference, application: Application.shape.application, repo_id: z.string().min(1),
  commit_sha: Version.shape.source.shape.commit_sha, deployment_id: z.string().min(1), url: z.string().url(),
  resource: z.string().url(), audience: z.string().min(1).max(500), scopes: Scopes,
  environment: z.enum(["local", "preview", "production"]), issuer: z.string().url(),
}).strict();
export type CredentialBinding = z.infer<typeof CredentialBinding>;

export async function getUpstreamAccount(db: GraphClient, owner: string, reference: string): Promise<UpstreamAccount | null> {
  return registryStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>("MATCH (n:UpstreamAccount {registry_key:$key}) RETURN n.doc AS doc", { key: canonicalJson([owner, reference]) });
    return rows[0] ? UpstreamAccount.parse(JSON.parse(rows[0].doc)) : null;
  });
}

export async function putUpstreamAccount(db: GraphClient, input: UpstreamAccount): Promise<UpstreamAccount> {
  const account = UpstreamAccount.parse(input);
  const content = canonicalDigest(account, ["created_at"]);
  return registryStorage(async () => {
    const rows = await db.query<{ doc: string; content: string }>(
      `MERGE (n:UpstreamAccount {registry_key:$key})
       ON CREATE SET n.owner_id=$owner,n.application=$app,n.auth_config_ref=$ref,n.doc=$doc,n.content=$content
       RETURN n.doc AS doc,n.content AS content`,
      { key: canonicalJson([account.owner_id, account.auth_config_ref]), owner: account.owner_id, app: account.application,
        ref: account.auth_config_ref, doc: canonicalJson(account), content },
    );
    if (!rows[0] || rows[0].content !== content) throw new FlywheelError("ingest_conflict", "Account reference already has a different credential authority; use a new reference.");
    return UpstreamAccount.parse(JSON.parse(rows[0].doc));
  });
}

export async function getCredentialBinding(db: GraphClient, owner: string, reference: string, url: string): Promise<CredentialBinding | null> {
  return registryStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>("MATCH (n:UpstreamCredentialBinding {registry_key:$key}) RETURN n.doc AS doc", { key: canonicalJson([owner, reference, url]) });
    return rows[0] ? CredentialBinding.parse(JSON.parse(rows[0].doc)) : null;
  });
}

export async function putCredentialBinding(db: GraphClient, input: CredentialBinding): Promise<CredentialBinding> {
  const binding = CredentialBinding.parse(input);
  const account = await getUpstreamAccount(db, binding.owner_id, binding.auth_config_ref);
  if (!account || account.application !== binding.application || account.repo_id !== binding.repo_id || account.environment !== binding.environment ||
      account.issuer !== binding.issuer || binding.scopes.some((scope) => !account.scopes.includes(scope))) {
    throw new FlywheelError("forbidden", "Credential binding is outside the linked account authority.");
  }
  const content = canonicalDigest(binding, ["created_at"]);
  return registryStorage(async () => {
    const rows = await db.query<{ doc: string; content: string }>(
      `MERGE (n:UpstreamCredentialBinding {registry_key:$key})
       ON CREATE SET n.owner_id=$owner,n.application=$app,n.auth_config_ref=$ref,n.doc=$doc,n.content=$content
       RETURN n.doc AS doc,n.content AS content`,
      { key: canonicalJson([binding.owner_id, binding.auth_config_ref, binding.url]), owner: binding.owner_id, app: binding.application,
        ref: binding.auth_config_ref, doc: canonicalJson(binding), content },
    );
    if (!rows[0] || rows[0].content !== content) throw new FlywheelError("ingest_conflict", "An immutable credential target cannot change its resource, audience or deployment authority.");
    return CredentialBinding.parse(JSON.parse(rows[0].doc));
  });
}
