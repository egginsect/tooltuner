import {
  Call, Feedback, ReportFeedbackInput, FlywheelError, SCHEMA_VERSION, LIMITS,
  canonicalDigest, newId, provenanceOf, type FlywheelHandlers,
} from "../contracts.js";
import type { GraphClient } from "../db/client.js";
import { appendFeedback, recordAccess } from "../db/evidence.js";
import { getVersion } from "../db/registry.js";
import { assertOperation, readScope, authorizedRecord, makeEvidence, sanitize } from "./evidence.js";

/** Explicit feedback only: neither retries nor a positive signal prove task success. */
export function createFeedbackHandler(db: GraphClient): NonNullable<FlywheelHandlers["report_feedback"]> {
  return async (ctx, raw) => {
    assertOperation(ctx, "report_feedback");
    const input = ReportFeedbackInput.parse(raw);
    const scope = await readScope(db, ctx);
    const calls = [];
    for (const ref of [...new Set(input.call_refs)].sort()) {
      const found = await authorizedRecord(db, ctx, scope, ref);
      if (found?.kind !== "call") throw new FlywheelError("not_found", "A feedback target was not found.");
      calls.push(Call.parse(found.record));
    }
    for (const ref of input.evidence_refs ?? []) {
      if (!await authorizedRecord(db, ctx, scope, ref)) throw new FlywheelError("not_found", "A feedback evidence ref was not found.");
    }
    const at = new Date().toISOString();
    const hasText = input.text !== undefined || input.observed !== undefined || input.expected !== undefined;
    const text = hasText ? makeEvidence(ctx.principal, "feedback_text", {
      text: input.text ?? null, observed: input.observed ?? null, expected: input.expected ?? null,
    }, undefined, at) : null;
    const clean = sanitize({ observed: input.observed ?? null, expected: input.expected ?? null }).value as { observed: string | null; expected: string | null };
    const feedback = Feedback.parse({ schema_version: SCHEMA_VERSION, owner_id: ctx.principal.owner_id,
      created_at: at, provenance: provenanceOf("flywheel", ctx.principal),
      completeness: text?.completeness ?? { status: "partial", missing_refs: [], notes: ["Feedback body is missing; no semantic matching is claimed."] },
      feedback_id: newId("feedback"), call_refs: calls.map((c) => c.call_id), source: "explicit", signal: input.signal,
      observed: clean.observed?.slice(0, LIMITS.maxTextChars) ?? null, expected: clean.expected?.slice(0, LIMITS.maxTextChars) ?? null, text_ref: text?.evidence_id ?? null,
      confidence: null, evidence_refs: [...new Set(input.evidence_refs ?? [])].sort(), idempotency_key: input.idempotency_key ?? null,
      content_digest: canonicalDigest({ ...input, call_refs: calls.map((c) => c.call_id),
        evidence_refs: [...new Set(input.evidence_refs ?? [])].sort(), idempotency_key: undefined }),
    });
    const repos = new Set<string>();
    for (const call of calls) {
      const version = await getVersion(db, call.owner_id, call.application, call.resolved_version);
      if (version) repos.add(version.source.repo_id);
    }
    const apps = new Set(calls.map((c) => c.application));
    const tools = new Set(calls.map((c) => `${c.application}:${c.tool}`));
    for (const ref of input.evidence_refs ?? []) {
      const access = await recordAccess(db, ctx.principal.owner_id, ref);
      for (const app of access?.apps ?? []) apps.add(app);
      for (const repo of access?.repos ?? []) repos.add(repo);
      for (const tool of access?.tools ?? []) tools.add(tool);
    }
    const key = canonicalDigest({ owner: ctx.principal.owner_id, grant: ctx.principal.grant_id,
      key: input.idempotency_key ?? feedback.feedback_id });
    const persisted = await appendFeedback(db, feedback, text, [...apps], [...repos], key, [...tools]);
    // Constructing a receipt before this awaited write would falsely acknowledge an outage.
    return { feedback_id: persisted.feedback_id, durable: true };
  };
}
