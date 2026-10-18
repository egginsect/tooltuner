import { Job, FlywheelError, canonicalJson, JOB_TRANSITIONS, type Job as JobRecord } from "../contracts.js";
import { StorageError } from "../errors.js";
import type { GraphClient } from "./client.js";
import type { IndexSpec } from "./schema.js";

export const JOB_INDEX_SPECS: readonly IndexSpec[] = [
  { label: "Job", property: "job_id", unique: true },
  { label: "Job", property: "request_key", unique: true },
  { label: "Job", property: "owner_id" },
];

export async function jobStorage<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof FlywheelError) throw error;
    throw new FlywheelError("storage_unavailable", "Job persistence failed; reconcile the saved job before retrying.", {
      certainty: error instanceof StorageError ? error.outcomeCertainty : "unknown",
    });
  }
}

export async function claimJob(db: GraphClient, input: JobRecord, requestDigest: string): Promise<{ job: JobRecord; created: boolean }> {
  const job = Job.parse(input);
  return jobStorage(async () => {
    const rows = await db.query<{ doc: string; request_digest: string }>(
      `MERGE (j:Job {request_key: $key})
       ON CREATE SET j.ref = $id, j.job_id = $id, j.owner_id = $owner, j.application = $app,
         j.packet_id = $packet, j.repo_id = $repo, j.created_at = $at, j.state = 'queued', j.request_digest = $digest, j.doc = $doc
       RETURN j.doc AS doc, j.request_digest AS request_digest`,
      { key: canonicalJson([job.owner_id, job.provenance.grant_id, job.submission_key]), id: job.job_id,
        owner: job.owner_id, app: job.application, packet: job.packet_id, repo: job.repo_id, at: job.created_at, digest: requestDigest, doc: canonicalJson(job) },
    );
    const row = rows[0];
    if (!row) throw new FlywheelError("outcome_unknown", "Job claim returned no durable receipt.");
    if (row.request_digest !== requestDigest) throw new FlywheelError("idempotency_conflict", "Launch key already identifies different job input.");
    const saved = Job.parse(JSON.parse(row.doc));
    return { job: saved, created: saved.job_id === job.job_id };
  });
}

export async function getJob(db: GraphClient, ownerId: string, jobId: string): Promise<JobRecord | null> {
  return jobStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>("MATCH (j:Job {job_id: $id, owner_id: $owner}) RETURN j.doc AS doc", { id: jobId, owner: ownerId });
    return rows[0] ? Job.parse(JSON.parse(rows[0].doc)) : null;
  });
}

/** Compare-and-set the full snapshot: concurrent polling cannot overwrite a newer receipt. */
export async function updateJob(db: GraphClient, previous: JobRecord, input: JobRecord): Promise<JobRecord> {
  const next = Job.parse(input);
  if (previous.state !== next.state && !JOB_TRANSITIONS[previous.state].includes(next.state)) {
    throw new FlywheelError("invalid_args", `Invalid job transition ${previous.state} -> ${next.state}.`);
  }
  if (next.job_id !== previous.job_id || next.owner_id !== previous.owner_id) throw new TypeError("Job identity is immutable.");
  return jobStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MATCH (j:Job {job_id: $id, owner_id: $owner}) WHERE j.doc = $before
       SET j.doc = $after, j.state = $state RETURN j.doc AS doc`,
      { id: next.job_id, owner: next.owner_id, before: canonicalJson(previous), after: canonicalJson(next), state: next.state },
    );
    if (!rows[0]) throw new FlywheelError("outcome_unknown", "Job changed concurrently; read its current state before proceeding.");
    return Job.parse(JSON.parse(rows[0].doc));
  });
}

/** Durable one-shot deployment claim. An interrupted claim is uncertain, never resubmitted. */
export async function claimDeployment(db: GraphClient, job: JobRecord): Promise<boolean> {
  return jobStorage(async () => (await db.query(
    `MATCH (j:Job {job_id: $id, owner_id: $owner})
     WHERE j.manager_attempted IS NULL AND j.doc = $doc
     SET j.manager_attempted = true RETURN j.job_id AS id`,
    { id: job.job_id, owner: job.owner_id, doc: canonicalJson(job) },
  )).length === 1);
}

export async function saveJobVerification(db: GraphClient, job: JobRecord, verification: unknown): Promise<void> {
  await jobStorage(async () => {
    const rows = await db.query(
      `MATCH (j:Job {job_id: $id, owner_id: $owner}) WHERE j.verification_doc IS NULL
       SET j.verification_doc = $doc RETURN j.job_id AS id`,
      { id: job.job_id, owner: job.owner_id, doc: canonicalJson(verification) },
    );
    if (!rows.length) throw new FlywheelError("outcome_unknown", "Deployment verification already exists or job is missing; re-read it.");
  });
}

export async function getJobVerification(db: GraphClient, ownerId: string, jobId: string): Promise<unknown | null> {
  return jobStorage(async () => {
    const rows = await db.roQuery<{ doc: string | null }>(
      "MATCH (j:Job {job_id: $id, owner_id: $owner}) RETURN j.verification_doc AS doc", { id: jobId, owner: ownerId },
    );
    return rows[0]?.doc ? JSON.parse(rows[0].doc) : null;
  });
}

export async function linkJob(db: GraphClient, job: JobRecord): Promise<void> {
  await jobStorage(async () => {
    await db.query(
      `MATCH (j:Job {job_id: $id, owner_id: $owner}), (p:Packet {packet_id: $packet, owner_id: $owner})
       MERGE (j)-[:FOR_PACKET]->(p)`, { id: job.job_id, owner: job.owner_id, packet: job.packet_id },
    );
    if (job.version_id) await db.query(
      `MATCH (j:Job {job_id: $id, owner_id: $owner}), (v:Version {version_id: $version, owner_id: $owner})
       MERGE (j)-[:PRODUCED]->(v)`, { id: job.job_id, owner: job.owner_id, version: job.version_id },
    );
  });
}
