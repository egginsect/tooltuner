import {
  Call, CallEvent, Evidence, Feedback, Packet, PACKET_DIGEST_EXCLUDED, FlywheelError, canonicalJson, canonicalDigest,
  type Grant, type Call as CallRecord, type CallEvent as EventRecord,
  type Evidence as EvidenceRecord, type Feedback as FeedbackRecord, type Packet as PacketRecord,
} from "../contracts.js";
import { StorageError } from "../errors.js";
import type { GraphClient, QueryParams } from "./client.js";
import type { IndexSpec } from "./schema.js";

export const EVIDENCE_INDEX_SPECS: readonly IndexSpec[] = [
  ...["Call", "CallEvent", "Evidence", "Feedback", "Packet"].map((label) => ({ label, property: "ref", unique: true })),
  { label: "Call", property: "admission_key", unique: true },
  { label: "Feedback", property: "feedback_key", unique: true },
  { label: "Packet", property: "packet_key", unique: true },
  ...["Call", "Evidence", "Feedback", "Packet"].map((label) => ({ label, property: "owner_id" })),
];

/** Preserve unknown write outcomes; never return an empty result for a failed read. */
export async function evidenceStorage<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof FlywheelError) throw error;
    if (error instanceof StorageError && error.code === "ingest_conflict") {
      throw new FlywheelError("ingest_conflict", "The persistent record identity conflicts with existing content.");
    }
    throw new FlywheelError("storage_unavailable", "Evidence persistence failed; reconcile stored refs before retrying.", {
      certainty: error instanceof StorageError ? error.outcomeCertainty : "unknown",
    });
  }
}

export type StoredRecord = { ref: string; kind: string; record: Record<string, unknown> };
const REF = "coalesce(n.ref,n.call_id,n.evidence_id,n.feedback_id,n.packet_id,n.job_id,n.version_id,n.evaluation_id,n.recommendation_id,n.decision_id)";

/** Internal owner-only loader. Public reads must additionally apply grant scope. */
export async function getRecord(db: GraphClient, ownerId: string, ref: string): Promise<StoredRecord | null> {
  return evidenceStorage(async () => {
    const rows = await db.roQuery<{ doc: string; kind: string }>(
      `MATCH (n) WHERE n.owner_id = $owner AND ${REF} = $ref RETURN n.doc AS doc, labels(n)[0] AS kind`,
      { owner: ownerId, ref },
    );
    return rows[0] ? { ref, kind: rows[0].kind.toLowerCase(), record: JSON.parse(rows[0].doc) as Record<string, unknown> } : null;
  });
}

export async function getPacket(db: GraphClient, ownerId: string, packetId: string): Promise<PacketRecord | null> {
  const found = await getRecord(db, ownerId, packetId);
  if (found?.kind !== "packet" || found.record["owner_id"] !== ownerId) return null;
  const packet = Packet.parse(found.record);
  if (packet.digest !== canonicalDigest(packet, PACKET_DIGEST_EXCLUDED)) throw new FlywheelError("storage_unavailable", "Stored packet digest does not match its frozen content.");
  return packet;
}
export async function getEvidence(db: GraphClient, ownerId: string, evidenceId: string): Promise<EvidenceRecord | null> {
  const found = await getRecord(db, ownerId, evidenceId);
  return found?.kind === "evidence" && found.record["owner_id"] === ownerId ? Evidence.parse(found.record) : null;
}
export async function getCall(db: GraphClient, ownerId: string, callId: string): Promise<CallRecord | null> {
  const found = await getRecord(db, ownerId, callId);
  return found?.kind === "call" ? Call.parse(found.record) : null;
}

/** Trusted recorder seam only: complete() receives a server-created call id. */
export async function loadRecorderCall(db: GraphClient, callId: string): Promise<CallRecord | null> {
  return evidenceStorage(async () => {
    const rows = await db.roQuery<{ doc: string }>("MATCH (c:Call {call_id:$id}) RETURN c.doc AS doc", { id: callId });
    return rows[0] ? Call.parse(JSON.parse(rows[0].doc)) : null;
  });
}

export const admissionKey = (owner: string, grant: string, app: string, tool: string, key: string) =>
  canonicalDigest({ owner, grant, app, tool, key });

export async function findCall(db: GraphClient, owner: string, key: string): Promise<{ call: CallRecord; args_digest: string } | null> {
  return evidenceStorage(async () => {
    const rows = await db.roQuery<{ doc: string; args_digest: string }>(
      "MATCH (c:Call {owner_id: $owner, admission_key: $key}) RETURN c.doc AS doc, c.args_digest AS args_digest", { owner, key },
    );
    return rows[0] ? { call: Call.parse(JSON.parse(rows[0].doc)), args_digest: rows[0].args_digest } : null;
  });
}

/** One durable statement admits a call, its input, event and all currently existing causal edges. */
export async function admitCall(db: GraphClient, call: CallRecord, event: EventRecord, input: EvidenceRecord,
  key: string, argsDigest: string, repos: string[]): Promise<CallRecord> {
  Call.parse(call); CallEvent.parse(event); Evidence.parse(input);
  return evidenceStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MERGE (c:Call {admission_key: $key})
       ON CREATE SET c.ref=$id, c.call_id=$id, c.owner_id=$owner, c.application=$app,
         c.applications=[$app], c.repo_ids=$repos, c.created_at=$at, c.doc=$doc,
         c.tool=$tool,c.tool_scopes=$tools,c.args_digest=$argsDigest,c.outcome='unknown',c.resolved_version=$version
       WITH c WHERE c.ref=$id
       CREATE (e:Evidence {ref:$inputId, evidence_id:$inputId, owner_id:$owner, applications:[$app],
         repo_ids:$repos,tool_scopes:$tools, created_at:$at, doc:$inputDoc})
       CREATE (v:CallEvent {ref:$eventId, event_id:$eventId, owner_id:$owner, applications:[$app],
         repo_ids:$repos,tool_scopes:$tools, created_at:$at, doc:$eventDoc, content_digest:$eventDigest})
       CREATE (c)-[:INPUT]->(e) CREATE (c)-[:HAS_EVENT]->(v)
       WITH c OPTIONAL MATCH (version:Version {version_id:$version,owner_id:$owner,application:$app})
       FOREACH (v IN CASE WHEN version IS NULL THEN [] ELSE [version] END | MERGE (c)-[:RESOLVED]->(v))
       WITH c OPTIONAL MATCH (parent:Call {owner_id:$owner,application:$app}) WHERE parent.call_id IN $causes
       WITH c, collect(parent) AS parents
       FOREACH (p IN parents | MERGE (c)-[:CAUSED_BY]->(p)) RETURN c.doc AS doc`,
      { key, id: call.call_id, owner: call.owner_id, app: call.application, repos, at: call.created_at,
        tool: call.tool, tools: [`${call.application}:${call.tool}`],
        doc: canonicalJson(call), argsDigest, version: call.resolved_version, inputId: input.evidence_id,
        inputDoc: canonicalJson(input), eventId: event.event_id, eventDoc: canonicalJson(event),
        eventDigest: event.content_digest, causes: call.causal_refs },
    );
    if (rows[0]) return Call.parse(JSON.parse(rows[0].doc));
    const prior = await findCall(db, call.owner_id, key);
    if (!prior || prior.args_digest !== argsDigest || prior.call.requested_version !== call.requested_version) {
      throw new FlywheelError("idempotency_conflict", "This dispatch key already identifies different input or a version selector.");
    }
    return prior.call;
  });
}

/** Domain ingest dedup is independent from dispatch idempotency. */
export async function appendCallEvent(db: GraphClient, ownerId: string, event: EventRecord): Promise<EventRecord> {
  CallEvent.parse(event);
  return evidenceStorage(async () => {
    const rows = await db.query<{ doc: string; owner: string }>(
      `MATCH (c:Call {call_id:$call,owner_id:$owner})
       MERGE (e:CallEvent {ref:$id})
       ON CREATE SET e.event_id=$id,e.owner_id=$owner,e.applications=c.applications,e.repo_ids=c.repo_ids,e.tool_scopes=c.tool_scopes,
         e.created_at=$at,e.doc=$doc,e.content_digest=$digest
       WITH c,e WHERE e.owner_id=$owner AND e.doc=$doc
       MERGE (c)-[:HAS_EVENT]->(e) RETURN e.doc AS doc,e.owner_id AS owner`,
      { owner: ownerId, call: event.call_id, id: event.event_id, at: event.at, doc: canonicalJson(event), digest: event.content_digest },
    );
    if (!rows[0]) throw new FlywheelError("ingest_conflict", "Event identity conflicts or its call is missing.");
    return CallEvent.parse(JSON.parse(rows[0].doc));
  });
}

/** Completion, output and event commit together; replay cannot overwrite a different completion. */
export async function completeCall(db: GraphClient, call: CallRecord, event: EventRecord, output: EvidenceRecord | null): Promise<void> {
  Call.parse(call); CallEvent.parse(event); if (output) Evidence.parse(output);
  await evidenceStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MATCH (c:Call {call_id:$id,owner_id:$owner})
       WHERE c.completion_digest IS NULL OR c.completion_digest=$digest
       MERGE (e:CallEvent {ref:$eventId})
       ON CREATE SET e.event_id=$eventId,e.owner_id=$owner,e.applications=c.applications,e.repo_ids=c.repo_ids,e.tool_scopes=c.tool_scopes,
         e.created_at=$at,e.doc=$eventDoc,e.content_digest=$digest
       WITH c,e WHERE e.owner_id=$owner AND e.content_digest=$digest AND e.doc=$eventDoc
       SET c.doc=$doc,c.outcome=$outcome,c.completion_digest=$digest
       MERGE (c)-[:HAS_EVENT]->(e)
       FOREACH (payload IN $outputs |
         MERGE (o:Evidence {ref:payload.id})
         ON CREATE SET o.evidence_id=payload.id,o.owner_id=$owner,o.applications=c.applications,
           o.repo_ids=c.repo_ids,o.tool_scopes=c.tool_scopes,o.created_at=$at,o.doc=payload.doc
         MERGE (c)-[:OUTPUT]->(o))
       RETURN c.doc AS doc`,
      { id: call.call_id, owner: call.owner_id, digest: event.content_digest, eventId: event.event_id,
        eventDoc: canonicalJson(event), at: event.at, doc: canonicalJson(call), outcome: call.outcome,
        outputs: output ? [{ id: output.evidence_id, doc: canonicalJson(output) }] : [] },
    );
    if (!rows[0]) throw new FlywheelError("ingest_conflict", "Completion conflicts with a prior event or its call is missing.");
  });
}

export async function appendFeedback(db: GraphClient, feedback: FeedbackRecord, text: EvidenceRecord | null,
  applications: string[], repos: string[], key: string, tools: string[]): Promise<FeedbackRecord> {
  Feedback.parse(feedback); if (text) Evidence.parse(text);
  return evidenceStorage(async () => {
    const rows = await db.query<{ doc: string }>(
      `MATCH (c:Call {owner_id:$owner}) WHERE c.call_id IN $calls
       WITH collect(c) AS calls WHERE size(calls)=$count
       MERGE (f:Feedback {feedback_key:$key})
       ON CREATE SET f.ref=$id,f.feedback_id=$id,f.owner_id=$owner,f.applications=$apps,
         f.repo_ids=$repos,f.tool_scopes=$tools,f.created_at=$at,f.doc=$doc,f.content_digest=$digest
       WITH f,calls WHERE f.ref=$id
       FOREACH (c IN calls | MERGE (f)-[:ABOUT]->(c))
       FOREACH (payload IN $texts |
         CREATE (t:Evidence {ref:payload.id,evidence_id:payload.id,owner_id:$owner,applications:$apps,
           repo_ids:$repos,tool_scopes:$tools,created_at:$at,doc:payload.doc}) CREATE (f)-[:TEXT]->(t))
       RETURN f.doc AS doc`,
      { owner: feedback.owner_id, calls: feedback.call_refs, count: feedback.call_refs.length, key, tools,
        id: feedback.feedback_id, apps: applications, repos, at: feedback.created_at, doc: canonicalJson(feedback),
        digest: feedback.content_digest, texts: text ? [{ id: text.evidence_id, doc: canonicalJson(text) }] : [] },
    );
    if (rows[0]) return Feedback.parse(JSON.parse(rows[0].doc));
    const existing = await db.roQuery<{ doc: string }>(
      "MATCH (f:Feedback {feedback_key:$key,owner_id:$owner}) RETURN f.doc AS doc", { key, owner: feedback.owner_id },
    );
    const prior = existing[0] ? Feedback.parse(JSON.parse(existing[0].doc)) : null;
    if (!prior || prior.content_digest !== feedback.content_digest) throw new FlywheelError("idempotency_conflict", "Feedback key already identifies different content or its calls are missing.");
    return prior;
  });
}

export async function freezePacket(db: GraphClient, packet: PacketRecord, toolScopes?: string[]): Promise<PacketRecord> {
  Packet.parse(packet);
  if (packet.digest !== canonicalDigest(packet, PACKET_DIGEST_EXCLUDED)) throw new FlywheelError("invalid_args", "Packet digest does not match its frozen content.");
  return evidenceStorage(async () => {
    const refs = [...packet.call_refs, ...packet.feedback_ids, ...packet.evidence_refs];
    const rows = await db.query<{ doc: string }>(
      `MATCH (v:Version {version_id:$version,owner_id:$owner,application:$app})
       OPTIONAL MATCH (n) WHERE n.owner_id=$owner AND ${REF} IN $refs
       WITH v,collect(n) AS records
       OPTIONAL MATCH (previous:Packet {packet_id:$previous,owner_id:$owner,application:$app})
       MERGE (p:Packet {packet_key:$key})
       ON CREATE SET p.ref=$id,p.packet_id=$id,p.owner_id=$owner,p.application=$app,p.applications=[$app],
         p.repo_ids=[$repo],p.tool_scopes=$tools,p.created_at=$at,p.doc=$doc,p.digest=$digest
       FOREACH (n IN records | MERGE (p)-[:INCLUDES]->(n))
       MERGE (p)-[:BASED_ON]->(v)
       FOREACH (s IN CASE WHEN previous IS NULL THEN [] ELSE [previous] END | MERGE (p)-[:SUCCESSOR_OF]->(s))
       RETURN p.doc AS doc`,
      { version: packet.parent_version_id, owner: packet.owner_id, app: packet.application, refs,
        previous: packet.successor_of, key: canonicalDigest({ owner: packet.owner_id, digest: packet.digest }),
        id: packet.packet_id, repo: packet.source.repo_id, at: packet.created_at, doc: canonicalJson(packet), digest: packet.digest,
        tools: toolScopes ?? packet.snapshot.calls.map((c) => `${String(c["application"])}:${String(c["tool"])}`) },
    );
    if (!rows[0]) throw new FlywheelError("not_found", "Packet baseline is missing.");
    return Packet.parse(JSON.parse(rows[0].doc));
  });
}

export interface ReadScope { owner: string; apps: string[]; repos: string[]; refs: string[] | null; toolApps: string[]; toolPairs: string[] }
const ALLOWED = `n.owner_id=$owner
 AND all(a IN coalesce(n.applications,[n.application]) WHERE a IN $apps OR '*' IN $apps)
 AND all(r IN coalesce(n.repo_ids,CASE WHEN n.repo_id IS NULL THEN [] ELSE [n.repo_id] END) WHERE r IN $repos)
 AND all(t IN coalesce(n.tool_scopes,[]) WHERE NOT split(t,':')[0] IN $toolApps OR t IN $toolPairs)
 AND ($unscoped OR ${REF} IN $refs)`;
const scopeParams = (scope: ReadScope): QueryParams => ({ owner: scope.owner, apps: scope.apps, repos: scope.repos,
  toolApps: scope.toolApps, toolPairs: scope.toolPairs, refs: scope.refs ?? [], unscoped: scope.refs === null });

/** Packet closure is loaded from the persisted Job edge, never from caller arguments. */
export async function packetForScope(db: GraphClient, owner: string, grant: Grant): Promise<PacketRecord | null> {
  return evidenceStorage(async () => {
    if (grant.scope.job_id) {
      const rows = await db.roQuery<{ doc: string; jobDoc: string }>(
        `MATCH (j:Job {job_id:$job,owner_id:$owner})-[:FOR_PACKET]->(p:Packet {owner_id:$owner})
         WHERE $packet IS NULL OR p.packet_id=$packet RETURN p.doc AS doc,j.doc AS jobDoc`,
        { job: grant.scope.job_id, owner, packet: grant.scope.packet_id ?? null },
      );
      if (!rows[0]) return null;
      const packetRef = Packet.parse(JSON.parse(rows[0].doc)).packet_id;
      const packet = await getPacket(db, owner, packetRef);
      if (!packet) return null;
      const job = JSON.parse(rows[0].jobDoc) as Record<string, unknown>;
      return job["owner_id"] === owner && job["job_id"] === grant.scope.job_id && job["packet_id"] === packet.packet_id &&
        job["application"] === packet.application && job["repo_id"] === packet.source.repo_id &&
        job["base_sha"] === packet.source.commit_sha ? packet : null;
    }
    return grant.scope.packet_id ? getPacket(db, owner, grant.scope.packet_id) : null;
  });
}

export async function readEvidence(db: GraphClient, scope: ReadScope, refs: string[]): Promise<StoredRecord[]> {
  if (refs.length === 0) return [];
  return evidenceStorage(async () => (await db.roQuery<{ ref: string; kind: string; doc: string }>(
    `MATCH (n) WHERE ${ALLOWED} AND ${REF} IN $requested
     RETURN ${REF} AS ref,labels(n)[0] AS kind,n.doc AS doc`, { ...scopeParams(scope), requested: refs },
  )).map((r) => ({ ref: r.ref, kind: r.kind.toLowerCase(), record: JSON.parse(r.doc) as Record<string, unknown> })));
}

/** Evidence is readable only through an extant, authorized source edge. */
export async function evidenceParents(db: GraphClient, owner: string, ref: string): Promise<string[]> {
  return evidenceStorage(async () => (await db.roQuery<{ ref: string }>(
    `MATCH (n)-[:INPUT|OUTPUT|TEXT]->(e:Evidence {ref:$ref,owner_id:$owner})
     WHERE n.owner_id=$owner RETURN coalesce(n.call_id,n.feedback_id) AS ref`, { owner, ref },
  )).map((r) => r.ref));
}

export async function recordAccess(db: GraphClient, owner: string, ref: string): Promise<{ apps: string[]; repos: string[]; tools: string[] } | null> {
  return evidenceStorage(async () => {
    const rows = await db.roQuery<{ apps: string[]; repos: string[]; tools: string[] }>(
      `MATCH (n) WHERE n.owner_id=$owner AND ${REF}=$ref
       RETURN coalesce(n.applications,[n.application]) AS apps,coalesce(n.repo_ids,[]) AS repos,coalesce(n.tool_scopes,[]) AS tools`,
      { owner, ref },
    );
    return rows[0] ?? null;
  });
}

export async function latestCallVersion(db: GraphClient, scope: ReadScope, application: string): Promise<string | null> {
  return evidenceStorage(async () => {
    const rows = await db.roQuery<{ version: string }>(
      `MATCH (n:Call) WHERE ${ALLOWED} AND n.application=$app
       RETURN n.resolved_version AS version ORDER BY n.created_at DESC,n.ref DESC LIMIT 1`, { ...scopeParams(scope), app: application },
    );
    return rows[0]?.version ?? null;
  });
}

export async function queryContext(db: GraphClient, scope: ReadScope, input: {
  application: string; version: string | null; call: string | null; afterAt: string; afterRef: string; limit: number;
}): Promise<StoredRecord[]> {
  return evidenceStorage(async () => (await db.roQuery<{ ref: string; kind: string; doc: string }>(
    `MATCH path=(c:Call)-[:RESOLVED|HAS_EVENT|INPUT|OUTPUT|ABOUT|TEXT|INCLUDES|BASED_ON|SUCCESSOR_OF|FOR_PACKET|PRODUCED|COMPARES|RAN|FROM|RECOMMENDS|SELECTED|EXPECTED_CURRENT|CAUSED_BY*0..6]-(n)
     WHERE c.owner_id=$owner AND c.application=$app AND c.resolved_version=$version
       AND ($call IS NULL OR c.call_id=$call)
       AND all(x IN nodes(path) WHERE x.owner_id=$owner
         AND all(a IN coalesce(x.applications,[x.application]) WHERE a IN $apps OR '*' IN $apps)
         AND all(r IN coalesce(x.repo_ids,CASE WHEN x.repo_id IS NULL THEN [] ELSE [x.repo_id] END) WHERE r IN $repos)
         AND all(t IN coalesce(x.tool_scopes,[]) WHERE NOT split(t,':')[0] IN $toolApps OR t IN $toolPairs)
         AND ($unscoped OR coalesce(x.ref,x.call_id,x.evidence_id,x.feedback_id,x.packet_id,x.job_id,x.version_id,x.evaluation_id) IN $refs)
         AND (NOT x:Call OR x.resolved_version=$version))
       AND ${ALLOWED} AND (n:Call OR n:Feedback OR n:Packet OR n:Job OR n:Version OR n:Evaluation)
       AND (n.created_at>$afterAt OR (n.created_at=$afterAt AND ${REF}>$afterRef))
     RETURN DISTINCT ${REF} AS ref,labels(n)[0] AS kind,n.doc AS doc ORDER BY n.created_at,ref LIMIT $limit`,
    { ...scopeParams(scope), app: input.application, version: input.version, call: input.call,
      afterAt: input.afterAt, afterRef: input.afterRef, limit: input.limit },
  )).map((r) => ({ ref: r.ref, kind: r.kind.toLowerCase(), record: JSON.parse(r.doc) as Record<string, unknown> })));
}

export async function lineageEdges(db: GraphClient, scope: ReadScope, refs: string[]): Promise<{ from: string; rel: string; to: string }[]> {
  return evidenceStorage(async () => db.roQuery<{ from: string; rel: string; to: string }>(
    `MATCH (n)-[r]->(m) WHERE ${ALLOWED} AND m.owner_id=$owner AND ${REF} IN $page
       AND coalesce(m.ref,m.call_id,m.evidence_id,m.feedback_id,m.packet_id,m.job_id,m.version_id,m.evaluation_id) IN $page
     RETURN DISTINCT ${REF} AS from,type(r) AS rel,
       coalesce(m.ref,m.call_id,m.evidence_id,m.feedback_id,m.packet_id,m.job_id,m.version_id,m.evaluation_id) AS to LIMIT 200`,
    { ...scopeParams(scope), page: refs },
  ));
}
