import {
  Call, Feedback, Evidence, Packet, CreatePacketInput, PACKET_DIGEST_EXCLUDED, FlywheelError,
  SCHEMA_VERSION, LIMITS, canonicalDigest, newId, provenanceOf, type FlywheelHandlers,
  type Call as CallRecord, type Feedback as FeedbackRecord, type Evidence as EvidenceRecord,
} from "../contracts.js";
import type { GraphClient } from "../db/client.js";
import { freezePacket, getPacket, recordAccess } from "../db/evidence.js";
import { getVersion } from "../db/registry.js";
import { assertOperation, readScope, authorizedRecord, sanitize } from "./evidence.js";

export function createPacketHandler(db: GraphClient): NonNullable<FlywheelHandlers["create_packet"]> {
  return async (ctx, raw) => {
    assertOperation(ctx, "create_packet");
    const input = CreatePacketInput.parse(raw);
    const scope = await readScope(db, ctx);
    const missing = new Set<string>();
    const calls: CallRecord[] = [];
    const feedback: FeedbackRecord[] = [];
    const evidence: EvidenceRecord[] = [];
    for (const ref of [...new Set(input.call_refs)].sort()) {
      const found = await authorizedRecord(db, ctx, scope, ref);
      if (found?.kind !== "call") missing.add(ref); else calls.push(Call.parse(found.record));
    }
    const baseline = calls[0];
    if (!baseline) throw new FlywheelError("not_found", "No authorized call baseline was found.");
    if (calls.some((c) => c.application !== baseline.application || c.resolved_version !== baseline.resolved_version)) {
      throw new FlywheelError("invalid_args", "A packet must have one application and one resolved baseline version.", { fieldPath: "call_refs" });
    }
    const version = await getVersion(db, ctx.principal.owner_id, baseline.application, baseline.resolved_version);
    if (!version || !ctx.grant.allow.repos.includes(version.source.repo_id)) throw new FlywheelError("not_found", "Packet baseline was not found.");
    const tools = new Set(calls.map((c) => `${c.application}:${c.tool}`));
    const withinBaseline = async (ref: string): Promise<boolean> => {
      const access = await recordAccess(db, ctx.principal.owner_id, ref);
      if (!access || access.apps.some((app) => app !== baseline.application) || access.repos.some((repo) => repo !== version.source.repo_id)) return false;
      for (const tool of access.tools) tools.add(tool);
      return true;
    };
    for (const ref of [...new Set(input.feedback_ids)].sort()) {
      const found = await authorizedRecord(db, ctx, scope, ref);
      if (found?.kind !== "feedback" || !await withinBaseline(ref)) { missing.add(ref); continue; }
      const f = Feedback.parse(found.record);
      if (f.call_refs.some((r) => !calls.some((c) => c.call_id === r))) { missing.add(ref); continue; }
      feedback.push(f);
    }
    const evidenceRefs = [...new Set([...input.evidence_refs ?? [],
      ...calls.flatMap((c) => [c.input_ref, c.output_ref].filter((r): r is string => r !== null)),
      ...feedback.flatMap((f) => [f.text_ref, ...f.evidence_refs].filter((r): r is string => r !== null))])].sort();
    for (const ref of evidenceRefs) {
      const found = await authorizedRecord(db, ctx, scope, ref);
      if (found?.kind !== "evidence" || !await withinBaseline(ref)) missing.add(ref); else evidence.push(Evidence.parse(found.record));
    }
    if (input.successor_of) {
      const prior = await getPacket(db, ctx.principal.owner_id, input.successor_of);
      if (!prior || prior.application !== baseline.application || prior.source.repo_id !== version.source.repo_id ||
        !await authorizedRecord(db, ctx, scope, prior.packet_id)) throw new FlywheelError("not_found", "The predecessor packet was not found.");
    }
    for (const c of calls) {
      for (const ref of c.completeness.missing_refs) missing.add(ref);
      if (!c.input_ref) missing.add(`${c.call_id}:input`);
      if (c.duration_ms === null) missing.add(`${c.call_id}:completion`);
      if (!c.output_ref) missing.add(`${c.call_id}:output`);
    }
    for (const f of feedback) if (!f.text_ref) missing.add(`${f.feedback_id}:text`);
    const firstInput = evidence.find((e) => e.evidence_id === baseline.input_ref);
    // A sanitized or truncated preview cannot be silently promoted to executable reproduction input.
    const args = firstInput && !firstInput.truncated && !firstInput.redacted_paths.length ? JSON.parse(firstInput.content_json) as Record<string, unknown> : null;
    const expected = feedback.find((f) => f.expected !== null)?.expected ?? null;
    const incomplete = missing.size > 0 || !args || evidence.some((e) => e.completeness.status !== "complete") || calls.some((c) => c.completeness.status !== "complete");
    const packet = Packet.parse({ schema_version: SCHEMA_VERSION, owner_id: ctx.principal.owner_id,
      created_at: new Date().toISOString(), provenance: provenanceOf("manager", ctx.principal),
      completeness: { status: incomplete ? "partial" : "complete", missing_refs: [...missing].sort(),
        notes: [...(args ? [] : ["No complete unredacted reproduction input is available."]),
          ...(incomplete ? ["Selected evidence has missing, redacted, truncated or unknown content."] : []),
          "Packet suggestions are untrusted; freezing does not launch a job or grant authority."] },
      packet_id: newId("packet"), digest: canonicalDigest({}), application: baseline.application,
      parent_version_id: version.version_id, source: version.source,
      call_refs: calls.map((c) => c.call_id), feedback_ids: feedback.map((f) => f.feedback_id),
      evidence_refs: evidence.map((e) => e.evidence_id), snapshot: { calls, feedback, evidence },
      capture_policy: "sanitized-bounded-v1", reproduction: args ? { tool: baseline.tool, args } : null,
      expected_outcome: expected, change_summary: String(sanitize(input.change_summary).value).slice(0, LIMITS.maxChangeSummaryChars),
      successor_of: input.successor_of ?? null, missing_refs: [...missing].sort(),
    });
    packet.digest = canonicalDigest(packet, PACKET_DIGEST_EXCLUDED);
    const saved = await freezePacket(db, packet, [...tools]);
    return { packet_id: saved.packet_id, digest: saved.digest, missing_refs: saved.missing_refs };
  };
}
