import { createHash } from "node:crypto";
import {
  Call, Evidence, FlywheelError, FLYWHEEL_APP, LIMITS, SCHEMA_VERSION,
  canonicalJson, canonicalDigest, newId, provenanceOf, GetContextInput, GetEvidenceInput,
  type Principal, type OperationContext, type FlywheelOperation, type CallAdmission,
  type CallCompletion, type CallRecorder, type FlywheelHandlers, type Completeness,
  type Evidence as EvidenceRecord, type Call as CallRecord, type OpOutput,
} from "../contracts.js";
import { appInScope, canUseTool } from "../policy.js";
import type { GraphClient } from "../db/client.js";
import { getVersion, getStable } from "../db/registry.js";
import {
  admitCall, admissionKey, completeCall, findCall, getRecord, loadRecorderCall,
  packetForScope, readEvidence, queryContext, latestCallVersion, lineageEdges, evidenceParents,
  type ReadScope, type StoredRecord,
} from "../db/evidence.js";
import { createFeedbackHandler } from "./feedback.js";
import { createPacketHandler } from "./packets.js";

const SECRET_KEY = /(?:pass(?:word|phrase)?|secret|token|authorization|cookie|credential|api[-_]?key|private[-_]?key|email|phone|address|ssn|social[-_]?security|full[-_]?name|first[-_]?name|last[-_]?name|date[-_]?of[-_]?birth)/i;
const SECRET_TEXT = [
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret|client[-_ ]?secret)["']?\s*[=:]\s*["']?[^\s"',;&}]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /([?&](?:token|key|secret|password|signature|credential|auth|api_key|access_token)=)[^\s&#"']+/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /(?:\(\d{3}\)\s*\d{3}[-. ]?\d{4}|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b)/g,
  /(?:\+\d[\d .()-]{8,}\d)/g,
];

/** Sanitize both structured keys and credential/PII strings embedded in ordinary prose. */
export function sanitize(value: unknown): { value: unknown; redacted_paths: string[] } {
  const paths = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (v: unknown, path: string, depth: number): unknown => {
    if (typeof v === "string") {
      let text = v;
      for (const re of SECRET_TEXT) text = text.replace(re, "[REDACTED]");
      if (text !== v) paths.add(path || "/");
      return text;
    }
    if (v === null || typeof v === "boolean" || typeof v === "number") return v;
    if (typeof v !== "object") return null;
    if (seen.has(v) || depth > 40) { paths.add(path || "/"); return "[REDACTED: unsupported nesting]"; }
    seen.add(v);
    const result = Array.isArray(v) ? v.map((x, i) => walk(x, `${path}/${i}`, depth + 1)) :
      Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([key, x]) => {
        const p = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (SECRET_KEY.test(key)) { paths.add(p); return [key, "[REDACTED]"]; }
        return [key, walk(x, p, depth + 1)];
      }));
    seen.delete(v);
    return result;
  };
  return { value: walk(value, "", 0), redacted_paths: [...paths].sort() };
}

/** Valid JSON is retained even when UTF-8, rather than JS character count, exceeds the cap. */
export function boundedCapture(value: unknown): { content_json: string; truncated: boolean; redacted_paths: string[] } {
  const clean = sanitize(value);
  const json = canonicalJson(clean.value);
  const paths: string[] = [];
  for (const path of clean.redacted_paths) {
    if (Buffer.byteLength(canonicalJson([...paths, path])) > 2048) break;
    paths.push(path);
  }
  const pathsTruncated = paths.length !== clean.redacted_paths.length;
  if (pathsTruncated) paths.push("/[additional redacted paths omitted]");
  if (Buffer.byteLength(json, "utf8") <= LIMITS.maxEvidenceBytes) return { content_json: json, truncated: pathsTruncated, redacted_paths: paths };
  let low = 0; let high = json.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = canonicalJson({ truncated: true, preview: json.slice(0, mid) });
    if (Buffer.byteLength(candidate, "utf8") <= LIMITS.maxEvidenceBytes) low = mid; else high = mid - 1;
  }
  return { content_json: canonicalJson({ truncated: true, preview: json.slice(0, low) }), truncated: true, redacted_paths: paths };
}

export function makeEvidence(principal: Principal, kind: EvidenceRecord["kind"], value: unknown,
  evidenceId = newId("evidence"), at = new Date().toISOString()): EvidenceRecord {
  const capture = boundedCapture(value);
  return Evidence.parse({ schema_version: SCHEMA_VERSION, owner_id: principal.owner_id, created_at: at,
    provenance: provenanceOf("flywheel", principal), completeness: {
      status: capture.truncated || capture.redacted_paths.length ? "partial" : "complete", missing_refs: [],
      notes: [...(capture.truncated ? ["Capture exceeds the UTF-8 budget; payload or redaction metadata is incomplete."] : []),
        ...(capture.redacted_paths.length ? ["Sensitive content was redacted."] : [])],
    }, evidence_id: evidenceId, kind, ...capture, digest: canonicalDigest(capture) });
}

const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 26)}`;

export function assertOperation(ctx: OperationContext, op: FlywheelOperation): void {
  if (ctx.principal.owner_id !== ctx.grant.owner_id || ctx.principal.grant_id !== ctx.grant.grant_id) {
    throw new FlywheelError("not_found", "The requested resource was not found.");
  }
  if (!canUseTool(ctx.grant, FLYWHEEL_APP, op)) throw new FlywheelError("forbidden", "The grant does not permit this operation.");
  if ((ctx.grant.scope.job_id || ctx.grant.scope.packet_id) && op !== "get_context" && op !== "get_evidence") {
    throw new FlywheelError("forbidden", "A coding scope permits development reads only.");
  }
}

export async function readScope(db: GraphClient, ctx: OperationContext): Promise<ReadScope> {
  const scope: ReadScope = { owner: ctx.principal.owner_id, apps: ctx.grant.allow.apps, repos: ctx.grant.allow.repos, refs: null,
    toolApps: Object.keys(ctx.grant.allow.tools), toolPairs: Object.entries(ctx.grant.allow.tools).flatMap(([app, tools]) => tools.map((tool) => `${app}:${tool}`)) };
  if (ctx.grant.scope.job_id || ctx.grant.scope.packet_id) {
    const packet = await packetForScope(db, scope.owner, ctx.grant);
    if (!packet || !appInScope(ctx.grant, packet.application) || !scope.repos.includes(packet.source.repo_id)) return { ...scope, refs: [] };
    scope.refs = [packet.packet_id, packet.parent_version_id, ...packet.call_refs, ...packet.feedback_ids, ...packet.evidence_refs,
      ...(ctx.grant.scope.job_id ? [ctx.grant.scope.job_id] : [])];
  }
  return scope;
}

/** Check complete record closure, not just the app named in a caller argument. */
export async function authorizedRecord(db: GraphClient, ctx: OperationContext, scope: ReadScope, ref: string): Promise<StoredRecord | null> {
  const result = (await readEvidence(db, scope, [ref]))[0];
  if (!result) return null;
  const r = result.record;
  if (r["owner_id"] !== undefined && r["owner_id"] !== ctx.principal.owner_id) return null;
  if (typeof r["application"] === "string" && !appInScope(ctx.grant, r["application"])) return null;
  const source = r["source"] as { repo_id?: string } | undefined;
  if (source?.repo_id && !ctx.grant.allow.repos.includes(source.repo_id)) return null;
  if (typeof r["repo_id"] === "string" && !ctx.grant.allow.repos.includes(r["repo_id"])) return null;
  if (result.kind === "call") {
    const call = Call.parse(r);
    const tools = ctx.grant.allow.tools[call.application];
    if (tools && !tools.includes(call.tool)) return null;
    const version = await getVersion(db, scope.owner, call.application, call.resolved_version);
    if (version && !ctx.grant.allow.repos.includes(version.source.repo_id)) return null;
  }
  // A multi-target feedback/packet must not expose records from another authorized app's denied tool.
  if (result.kind === "feedback" || result.kind === "packet") {
    const calls = r["call_refs"] as string[];
    for (const callRef of calls) {
      const call = (await readEvidence(db, scope, [callRef]))[0];
      if (!call || call.kind !== "call") return null;
      const tools = ctx.grant.allow.tools[String(call.record["application"])];
      if (tools && !tools.includes(String(call.record["tool"]))) return null;
    }
  }
  if (result.kind === "evidence") {
    const parents = await evidenceParents(db, scope.owner, ref);
    if (parents.length === 0) return null;
    for (const parent of parents) if (!await authorizedRecord(db, ctx, { ...scope, refs: null }, parent)) return null;
  }
  return result;
}

export function principalFor(call: CallRecord): Principal {
  return { owner_id: call.owner_id, subject: call.subject, client_id: call.client_id, grant_id: call.grant_id, session_id: call.session_id };
}

function createRecorder(db: GraphClient): CallRecorder {
  return {
    async admit(a: CallAdmission) {
      const at = new Date().toISOString();
      const callId = newId("call");
      const input = makeEvidence(a.principal, "call_input", a.args, undefined, at);
      const missing: string[] = [];
      for (const ref of a.causal_refs) {
        const prior = await getRecord(db, a.principal.owner_id, ref);
        if (prior?.kind !== "call" || prior.record["application"] !== a.application) missing.push(ref);
      }
      const version = await getVersion(db, a.principal.owner_id, a.application, a.resolved_version);
      if (!version && a.application !== FLYWHEEL_APP) missing.push(a.resolved_version);
      const call = Call.parse({ schema_version: SCHEMA_VERSION, owner_id: a.principal.owner_id, created_at: at,
        provenance: provenanceOf("gateway", a.principal), completeness: { status: "unknown", missing_refs: missing,
          notes: ["Completion has not been durably recorded.", ...input.completeness.notes] },
        call_id: callId, subject: a.principal.subject, session_id: a.principal.session_id, run_id: null,
        client_id: a.principal.client_id, grant_id: a.principal.grant_id, application: a.application, tool: a.tool,
        requested_version: a.requested_version, resolved_version: a.resolved_version, schema_digest: a.schema_digest,
        idempotency_key: a.idempotency_key, input_ref: input.evidence_id, output_ref: null,
        causal_refs: a.causal_refs.filter((r) => !missing.includes(r)), outcome: "unknown", error: null, duration_ms: null });
      const argsDigest = canonicalDigest(a.args);
      const result = await admitCall(db, call, { event_id: newId("event"), call_id: callId, kind: "admission", at,
        content_digest: canonicalDigest({ ...a, args: argsDigest }) }, input,
      a.idempotency_key ? admissionKey(call.owner_id, call.grant_id, call.application, call.tool, a.idempotency_key) : callId,
      argsDigest, version ? [version.source.repo_id] : []);
      // admit() is an execution permit. A durable same-key record belongs to another
      // attempt, even if both gateway instances observed no call in their preflight read.
      if (result.call_id !== callId) throw new FlywheelError("outcome_unknown",
        `Call ${result.call_id} was already admitted; reconcile that call before retrying.`, { certainty: "unknown" });
      return { call_id: result.call_id };
    },
    async complete(callId: string, completion: CallCompletion) {
      const call = await loadRecorderCall(db, callId);
      if (!call) throw new FlywheelError("not_found", "Call admission was not found.");
      const at = new Date(Date.parse(call.created_at) + completion.duration_ms).toISOString();
      const output = completion.result === undefined ? null : makeEvidence(principalFor(call), "call_output", completion.result,
        stableId("evd", `${callId}:output`), at);
      const errorCapture = completion.error === null ? null : sanitize(completion.error);
      const cleanError = errorCapture?.value as CallCompletion["error"];
      const errorIncomplete = (errorCapture?.redacted_paths.length ?? 0) > 0 || (cleanError?.message.length ?? 0) > LIMITS.maxTextChars;
      if (cleanError) cleanError.message = cleanError.message.slice(0, LIMITS.maxTextChars);
      const incomplete = errorIncomplete || completion.outcome === "unknown" || !output || output.completeness.status !== "complete";
      const input = call.input_ref ? await getRecord(db, call.owner_id, call.input_ref) : null;
      const inputIncomplete = input?.record["completeness"] as Completeness | undefined;
      const missingRefs = [...new Set([...call.completeness.missing_refs, ...(!input ? [call.input_ref ?? `${call.call_id}:input`] : [])])];
      const final = Call.parse({ ...call, output_ref: output?.evidence_id ?? null, outcome: completion.outcome,
        error: cleanError ?? null, duration_ms: completion.duration_ms, completeness: {
          status: completion.outcome === "unknown" ? "unknown" : incomplete || inputIncomplete?.status !== "complete" || call.completeness.missing_refs.length ? "partial" : "complete",
          missing_refs: missingRefs,
          notes: [...(inputIncomplete?.notes ?? []), ...(output?.completeness.notes ?? []),
            ...(errorIncomplete ? ["Error details were sanitized or bounded."] : []),
            ...(!output ? ["Completion has no captured result payload."] : []),
            ...(completion.outcome === "unknown" ? ["The upstream outcome is unknown; do not replay side effects blindly."] : [])],
        } });
      await completeCall(db, final, { event_id: stableId("evt", `${callId}:completion`), call_id: callId,
        kind: "completion", at, content_digest: canonicalDigest({ ...completion }) }, output);
    },
    async findIdempotent(principal, application, tool, key) {
      const prior = await findCall(db, principal.owner_id, admissionKey(principal.owner_id, principal.grant_id, application, tool, key));
      if (!prior) return null;
      const output = prior.call.output_ref ? await getRecord(db, principal.owner_id, prior.call.output_ref) : null;
      // A sanitized/truncated capture cannot be represented as the original upstream response.
      const evidence = output?.kind === "evidence" ? Evidence.parse(output.record) : null;
      const result = evidence && !evidence.truncated && evidence.redacted_paths.length === 0 ? JSON.parse(evidence.content_json) as unknown : undefined;
      if (prior.call.output_ref && !evidence) prior.call.completeness = { status: "partial",
        missing_refs: [...new Set([...prior.call.completeness.missing_refs, prior.call.output_ref])],
        notes: [...prior.call.completeness.notes, "The recorded output payload is missing; replay cannot return the original response."] };
      return { ...prior, result };
    },
  };
}

export interface EvidenceOptions {
  /** Maximum serialized read response, default 64 KiB; must accommodate a full evidence record. */
  maxResponseBytes?: number;
}

type Cursor = { q: string; at: string; ref: string };
function cursorQuery(ctx: OperationContext, query: unknown): string {
  return canonicalDigest({ owner: ctx.principal.owner_id, grant: ctx.grant, query }).slice(7, 23);
}
function decodeCursor(value: string | undefined, q: string): Cursor {
  if (!value) return { q, at: "", ref: "" };
  try {
    const c = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (c.q !== q || typeof c.at !== "string" || typeof c.ref !== "string") throw new Error();
    return c;
  } catch { throw new FlywheelError("invalid_args", "Cursor does not belong to this owner and query.", { fieldPath: "cursor" }); }
}
const encodeCursor = (q: string, at: string, ref: string) => Buffer.from(canonicalJson({ q, at, ref })).toString("base64url");
const byteSize = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8");

export function createEvidenceService(db: GraphClient, options: EvidenceOptions = {}): { recorder: CallRecorder; handlers: FlywheelHandlers } {
  const maxBytes = options.maxResponseBytes ?? 65_536;
  if (!Number.isInteger(maxBytes) || maxBytes < 24_576) throw new TypeError("maxResponseBytes must be an integer of at least 24576 bytes.");
  const handlers: FlywheelHandlers = {
    report_feedback: createFeedbackHandler(db), create_packet: createPacketHandler(db),
    async get_evidence(ctx, raw) {
      assertOperation(ctx, "get_evidence");
      const input = GetEvidenceInput.parse(raw);
      const q = cursorQuery(ctx, { op: "get_evidence", refs: [...new Set(input.refs)].sort() });
      const cursor = decodeCursor(input.cursor, q);
      const scope = await readScope(db, ctx);
      const items: OpOutput<"get_evidence">["items"] = [];
      const missing: string[] = [];
      const refs = [...new Set(input.refs)].sort().filter((r) => r > cursor.ref);
      let next: string | null = null;
      let last = cursor.ref;
      for (const ref of refs) {
        if (items.length >= (input.limit ?? LIMITS.defaultPageSize)) { next = encodeCursor(q, "", last); break; }
        const found = await authorizedRecord(db, ctx, scope, ref);
        if (!found) { missing.push(ref); last = ref; continue; }
        let item = found;
        if (byteSize(item) > maxBytes - 4096) item = { ...item, record: {
          schema_version: found.record["schema_version"], owner_id: found.record["owner_id"],
          created_at: found.record["created_at"], provenance: found.record["provenance"], digest: found.record["digest"],
          ...Object.fromEntries(["packet_id", "call_refs", "feedback_ids", "evidence_refs", "missing_refs", "input_ref", "output_ref", "text_ref"]
            .filter((key) => found.record[key] !== undefined).map((key) => [key, found.record[key]])),
          truncated: true, completeness: { status: "partial", missing_refs: [], notes: ["Record exceeds response budget; expand its exact evidence refs individually."] },
        } };
        if (byteSize({ items: [...items, item], missing_refs: missing, next_cursor: null }) > maxBytes - 512) {
          next = encodeCursor(q, "", last); break;
        }
        items.push(item); last = ref;
      }
      return { items, missing_refs: missing, next_cursor: next };
    },
    async get_context(ctx, raw) {
      assertOperation(ctx, "get_context");
      const input = GetContextInput.parse(raw);
      const scope = await readScope(db, ctx);
      const missing: string[] = [];
      let version: string | null = null;
      if (!appInScope(ctx.grant, input.application)) {
        return { items: [], lineage: [], completeness: { status: "partial", missing_refs: [input.call_ref ?? input.application], notes: [] }, next_cursor: null };
      }
      if (input.call_ref) {
        const call = await authorizedRecord(db, ctx, scope, input.call_ref);
        if (call?.kind === "call" && call.record["application"] === input.application) version = String(call.record["resolved_version"]);
        else missing.push(input.call_ref);
      }
      if (input.version) {
        const selected = await getVersion(db, scope.owner, input.application, input.version);
        if (!selected || !ctx.grant.allow.repos.includes(selected.source.repo_id) || (version && version !== selected.version_id)) missing.push(input.version);
        else version = selected.version_id;
      } else if (!version && missing.length === 0) {
        const stable = await getStable(db, scope.owner, input.application);
        version = stable?.version_id ?? await latestCallVersion(db, scope, input.application);
      }
      if (missing.length || !version) return { items: [], lineage: [], completeness: {
        status: "partial", missing_refs: missing, notes: ["No authorized resolved context was found."] }, next_cursor: null };
      const q = cursorQuery(ctx, { op: "get_context", application: input.application, version: input.version,
        resolved_version: version, call: input.call_ref });
      const cursor = decodeCursor(input.cursor, q);
      const limit = input.limit ?? LIMITS.defaultPageSize;
      const records = await queryContext(db, scope, { application: input.application, version, call: input.call_ref ?? null,
        afterAt: cursor.at, afterRef: cursor.ref, limit: limit + 1 });
      const items: OpOutput<"get_context">["items"] = [];
      let hasMore = records.length > limit;
      const notes = [`Resolved context: ${input.application}/${version}.`];
      let partial = false;
      for (const r of records.slice(0, limit)) {
        if (!await authorizedRecord(db, ctx, scope, r.ref)) continue;
        const comp = r.record["completeness"] as Completeness;
        if (comp?.status !== "complete") partial = true;
        for (const ref of comp?.missing_refs ?? []) if (!missing.includes(ref)) missing.push(ref);
        const summary = Object.fromEntries(["application", "tool", "resolved_version", "outcome", "signal", "digest", "parent_version_id", "source", "state", "completeness", "provenance"]
          .filter((key) => r.record[key] !== undefined).map((key) => [key, r.record[key]]));
        const item = { ref: r.ref, kind: r.kind as OpOutput<"get_context">["items"][number]["kind"], created_at: String(r.record["created_at"]), summary };
        if (byteSize([...items, item]) > maxBytes - 20_000) { hasMore = true; break; }
        items.push(item);
      }
      const last = items.at(-1);
      const lineage = await lineageEdges(db, scope, items.map((r) => r.ref));
      if (hasMore) notes.push("Additional authorized records remain; continue with next_cursor.");
      if (!items.length) notes.push("No related records were found along the stored graph edges.");
      const response = { items, lineage, completeness: { status: hasMore || partial || missing.length || !items.length ? "partial" as const : "complete" as const, missing_refs: missing, notes },
        next_cursor: hasMore && last ? encodeCursor(q, last.created_at, last.ref) : null };
      if (byteSize(response) > maxBytes) {
        response.completeness.status = "partial";
        notes.push("Some lineage edges exceeded the response byte budget.");
        while (lineage.length && byteSize(response) > maxBytes) lineage.pop();
      }
      return response;
    },
  };
  return { recorder: createRecorder(db), handlers };
}
