import { Evaluation, Recommendation, FlywheelError, canonicalJson, type Evaluation as EvaluationRecord, type Recommendation as RecommendationRecord } from "../contracts.js";
import { jobStorage } from "./jobs.js";
import type { GraphClient } from "./client.js";
import type { IndexSpec } from "./schema.js";

export const EXPERIMENT_INDEX_SPECS: readonly IndexSpec[] = [
  { label: "Evaluation", property: "evaluation_id", unique: true },
  { label: "Evaluation", property: "request_key", unique: true },
  { label: "Recommendation", property: "recommendation_id", unique: true },
  { label: "Recommendation", property: "request_key", unique: true },
];

export async function claimEvaluation(db: GraphClient, evaluation: EvaluationRecord, requestDigest: string, snapshot: unknown, repoIds: readonly string[] = []): Promise<{ evaluation: EvaluationRecord; created: boolean }> {
  Evaluation.parse(evaluation);
  return jobStorage(async () => {
    const rows = await db.query<{ doc: string; digest: string }>(
      `MERGE (e:Evaluation {request_key: $key})
       ON CREATE SET e.ref = $id, e.evaluation_id = $id, e.owner_id = $owner, e.application = $app,
         e.created_at = $at, e.repo_ids = $repos, e.state = 'queued', e.request_digest = $digest, e.snapshot = $snapshot, e.doc = $doc
       RETURN e.doc AS doc, e.request_digest AS digest`,
      { key: canonicalJson([evaluation.owner_id, evaluation.provenance.grant_id, evaluation.idempotency_key]),
        id: evaluation.evaluation_id, owner: evaluation.owner_id, app: evaluation.application,
        at: evaluation.created_at, repos: [...repoIds], digest: requestDigest, snapshot: canonicalJson(snapshot), doc: canonicalJson(evaluation) },
    );
    const row = rows[0];
    if (!row) throw new FlywheelError("outcome_unknown", "Comparison claim returned no durable receipt.");
    if (row.digest !== requestDigest) throw new FlywheelError("idempotency_conflict", "Comparison key already identifies different frozen input or configuration.");
    const saved = Evaluation.parse(JSON.parse(row.doc));
    return { evaluation: saved, created: saved.evaluation_id === evaluation.evaluation_id };
  });
}

export async function findEvaluation(db: GraphClient, owner: string, grant: string, key: string): Promise<{ evaluation: EvaluationRecord; digest: string } | null> {
  return jobStorage(async () => {
    const rows = await db.roQuery<{ doc: string; digest: string }>(
      "MATCH (e:Evaluation {request_key: $key}) RETURN e.doc AS doc, e.request_digest AS digest", { key: canonicalJson([owner, grant, key]) },
    );
    return rows[0] ? { evaluation: Evaluation.parse(JSON.parse(rows[0].doc)), digest: rows[0].digest } : null;
  });
}

export async function getEvaluation(db: GraphClient, owner: string, id: string): Promise<EvaluationRecord | null> {
  return jobStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>("MATCH (e:Evaluation {evaluation_id: $id, owner_id: $owner}) RETURN e.doc AS doc", { owner, id });
    return rows[0] ? Evaluation.parse(JSON.parse(rows[0].doc)) : null;
  });
}

export async function updateEvaluation(db: GraphClient, previous: EvaluationRecord, next: EvaluationRecord): Promise<EvaluationRecord> {
  Evaluation.parse(next);
  return jobStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MATCH (e:Evaluation {evaluation_id: $id, owner_id: $owner}) WHERE e.doc = $before
       SET e.doc = $after, e.state = $state RETURN e.doc AS doc`,
      { id: previous.evaluation_id, owner: previous.owner_id, before: canonicalJson(previous), after: canonicalJson(next), state: next.state },
    );
    if (!rows[0]) throw new FlywheelError("outcome_unknown", "Comparison changed concurrently; read the saved result.");
    return Evaluation.parse(JSON.parse(rows[0].doc));
  });
}

/** Content-addressed recommendation: a repeated suggestion returns the same durable record. */
export async function insertRecommendation(db: GraphClient, recommendation: RecommendationRecord, digest: string, repoIds: readonly string[] = []): Promise<RecommendationRecord> {
  Recommendation.parse(recommendation);
  return jobStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MERGE (r:Recommendation {request_key: $key})
       ON CREATE SET r.ref = $id, r.recommendation_id = $id, r.owner_id = $owner, r.application = $app, r.created_at = $at, r.repo_ids = $repos, r.doc = $doc
       RETURN r.doc AS doc`,
      { key: canonicalJson([recommendation.owner_id, recommendation.provenance.grant_id, digest]),
        id: recommendation.recommendation_id, owner: recommendation.owner_id, app: recommendation.application, at: recommendation.created_at, repos: [...repoIds], doc: canonicalJson(recommendation) },
    );
    if (!rows[0]) throw new FlywheelError("outcome_unknown", "Recommendation write returned no durable receipt.");
    const saved = Recommendation.parse(JSON.parse(rows[0].doc));
    await db.query(`MATCH (r:Recommendation {recommendation_id:$id, owner_id:$owner}), (v:Version {owner_id:$owner})
      WHERE v.version_id IN $versions MERGE (r)-[:RECOMMENDS]->(v)`, { id: saved.recommendation_id, owner: saved.owner_id, versions: saved.version_ids });
    return saved;
  });
}

export async function linkEvaluation(db: GraphClient, evaluation: EvaluationRecord): Promise<void> {
  await jobStorage(async () => {
    await db.query(
      `MATCH (e:Evaluation {evaluation_id: $id, owner_id: $owner}), (v:Version {owner_id: $owner})
       WHERE v.version_id IN $versions MERGE (e)-[:COMPARES]->(v)`,
      { id: evaluation.evaluation_id, owner: evaluation.owner_id, versions: evaluation.version_ids },
    );
    const refs = evaluation.results.flatMap((r) => r.call_ref ? [r.call_ref] : []);
    await db.query(
      `MATCH (e:Evaluation {evaluation_id: $id, owner_id: $owner}), (c:Call {owner_id: $owner})
       WHERE c.call_id IN $refs MERGE (e)-[:RAN]->(c)`, { id: evaluation.evaluation_id, owner: evaluation.owner_id, refs },
    );
    for (const ref of evaluation.recommendation_refs) await db.query(
      `MATCH (e:Evaluation {evaluation_id: $id, owner_id: $owner}), (r:Recommendation {recommendation_id: $ref, owner_id: $owner})
       MERGE (r)-[:FROM]->(e)`, { id: evaluation.evaluation_id, owner: evaluation.owner_id, ref },
    );
  });
}

/** Internal replay authorization reads the durable snapshot, never caller-supplied evidence. */
export async function getEvaluationSnapshot(db: GraphClient, owner: string, id: string): Promise<unknown | null> {
  return jobStorage(async () => {
    const rows = await db.roQuery<{ snapshot: string }>("MATCH (e:Evaluation {evaluation_id:$id, owner_id:$owner}) RETURN e.snapshot AS snapshot", { id, owner });
    return rows[0]?.snapshot ? JSON.parse(rows[0].snapshot) : null;
  });
}
