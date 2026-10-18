import { z } from "zod";
import { isVersionReady } from "../db/registry.js";
import {
  Evaluation, Recommendation, FlywheelError, RunExperimentInput, GetExperimentInput, RecommendCandidateInput,
  canonicalDigest, canonicalJson, newId, provenanceOf, COMPLETE, Version as VersionSchema,
  type FlywheelHandlers, type OperationContext, type Version, type Call, type Evidence, type Packet, type DispatchOutput, type CallRecorder, type CallCompletion,
} from "../contracts.js";
import { assertAppInScope, assertRepoAllowed, canUseTool } from "../policy.js";
import { claimEvaluation, findEvaluation, getEvaluation, updateEvaluation, insertRecommendation, linkEvaluation, getEvaluationSnapshot } from "../db/experiments.js";
import type { GraphClient } from "../db/client.js";

export type ExperimentHandlers = Pick<Required<FlywheelHandlers>, "run_experiment" | "get_experiment" | "recommend_candidate">;
export interface ExperimentRunConfig {
  /** An immutable revision, e.g. config:readonly-v1. Changed criteria/configuration require a new ref. */
  ref: string;
  fixtureStateRef: string;
  expectedOutput: unknown;
  /** Only non-destructive read-only tools are replayed. Tool output is measured, not agent task success. */
  maxVersions: number;
}
export interface ExperimentServiceOptions {
  db: GraphClient;
  configs: readonly ExperimentRunConfig[];
  getPacket(db: GraphClient, ownerId: string, id: string): Promise<Packet | null>;
  getCall(db: GraphClient, ownerId: string, id: string): Promise<Call | null>;
  getEvidence(db: GraphClient, ownerId: string, id: string): Promise<Evidence | null>;
  getVersion(ownerId: string, application: string, exactVersionId: string): Promise<Version | null>;
  /** Trusted internal operation; never route this through public USER dispatch or union grant groups. */
  replay?: (ctx: OperationContext, input: TrustedTrialRequest) => Promise<DispatchOutput>;
}
export interface TrustedTrialRequest {
  application: string; version: string; tool: string; args: Record<string, unknown>; idempotency_key: string;
  evaluation_id: string; input_ref: string; input_digest: string; version_digest: string;
  schema_digest: string; fixture_state_ref: string;
}
interface FrozenInput { tool: string; args: Record<string, unknown>; digest: string; repoId: string }
function authorize(ctx: OperationContext, operation: "run_experiment" | "get_experiment" | "recommend_candidate", app?: string): void {
  if (ctx.principal.owner_id !== ctx.grant.owner_id || ctx.principal.grant_id !== ctx.grant.grant_id || !canUseTool(ctx.grant, "flywheel", operation) || ctx.grant.scope.job_id || ctx.grant.scope.packet_id) {
    throw new FlywheelError("forbidden", "An active unscoped MANAGEMENT grant is required for comparisons.");
  }
  if (app) assertAppInScope(ctx.grant, app);
}
export function expectedOutputCriterion(actual: unknown, expected: unknown): "pass" | "fail" {
  return canonicalJson(actual) === canonicalJson(expected) ? "pass" : "fail";
}
export function createExperimentService(options: ExperimentServiceOptions): ExperimentHandlers {
  const { db } = options;
  const active = new Set<string>();
  async function inputFor(ctx: OperationContext, application: string, ref: string): Promise<FrozenInput | null> {
    const owner = ctx.principal.owner_id;
    if (ref.startsWith("pkt_")) {
      const packet = await options.getPacket(db, owner, ref);
      if (!packet || packet.owner_id !== owner || packet.application !== application || !packet.reproduction || packet.missing_refs.length || packet.completeness.status !== "complete") return null;
      assertRepoAllowed(ctx.grant, packet.source.repo_id);
      assertTrialToolAllowed(ctx, application, packet.reproduction.tool);
      return { ...packet.reproduction, digest: packet.digest, repoId: packet.source.repo_id };
    }
    const call = await options.getCall(db, owner, ref);
    if (!call || call.owner_id !== owner || call.application !== application || !call.input_ref || call.completeness.status !== "complete") return null;
    const source = await options.getVersion(owner, application, call.resolved_version);
    if (!source || source.owner_id !== owner || source.application !== application || source.version_id !== call.resolved_version) return null;
    assertRepoAllowed(ctx.grant, source.source.repo_id);
    assertTrialToolAllowed(ctx, application, call.tool);
    const evidence = await options.getEvidence(db, owner, call.input_ref);
    if (!evidence || evidence.owner_id !== owner || evidence.kind !== "call_input" || evidence.truncated || evidence.redacted_paths.length || evidence.completeness.status !== "complete") return null;
    try {
      const args: unknown = JSON.parse(evidence.content_json);
      if (!args || typeof args !== "object" || Array.isArray(args)) return null;
      return { tool: call.tool, args: args as Record<string, unknown>, digest: evidence.digest, repoId: source.source.repo_id };
    } catch { return null; }
  }
  async function authorizedEvaluation(ctx: OperationContext, id: string): Promise<Evaluation> {
    const evaluation = await getEvaluation(db, ctx.principal.owner_id, id);
    if (!evaluation) throw new FlywheelError("not_found", "Comparison was not found.");
    assertAppInScope(ctx.grant, evaluation.application);
    const snapshot = await getEvaluationSnapshot(db, evaluation.owner_id, id);
    const parsed = TrialSnapshot.safeParse(snapshot);
    if (!parsed.success) throw new FlywheelError("operation_unavailable", "Comparison scope snapshot is unavailable; do not replay it.");
    if (parsed.data.input) assertRepoAllowed(ctx.grant, parsed.data.input.repoId);
    for (const version of parsed.data.versions) if (version) {
      assertRepoAllowed(ctx.grant, version.source.repo_id);
      if (parsed.data.input) assertTrialToolAllowed(ctx, version.application, parsed.data.input.tool);
    }
    return evaluation;
  }
  return {
    async run_experiment(ctx, raw) {
      const input = RunExperimentInput.parse(raw);
      authorize(ctx, "run_experiment", input.application);
      if (new Set(input.version_ids).size !== input.version_ids.length) throw new FlywheelError("invalid_args", "Comparisons require distinct exact version IDs.");
      // Request identity is checked before configuration lookup: retries never rerun or rewrite an old trial.
      const requestDigest = canonicalDigest(input);
      const prior = await findEvaluation(db, ctx.principal.owner_id, ctx.grant.grant_id, input.idempotency_key);
      if (prior) {
        if (prior.digest !== requestDigest) throw new FlywheelError("idempotency_conflict", "Comparison key already identifies different input.");
        await authorizedEvaluation(ctx, prior.evaluation.evaluation_id);
        await linkEvaluation(db, prior.evaluation);
        return { evaluation_id: prior.evaluation.evaluation_id, state: prior.evaluation.state };
      }
      if (input.criterion_ref !== "criterion:expected-output") throw new FlywheelError("invalid_args", "Supported deterministic criterion: criterion:expected-output.");
      const configured = options.configs.find((c) => c.ref === input.config_ref);
      const config = configured ? structuredClone(configured) : undefined;
      if (!config || !config.fixtureStateRef || input.version_ids.length > config.maxVersions) throw new FlywheelError("invalid_args", "Select a configured immutable run configuration and fixture state.");
      const frozen = await inputFor(ctx, input.application, input.input_ref);
      const versions: (Version | null)[] = [];
      const missing: string[] = [];
      for (const id of input.version_ids) {
        const version = await options.getVersion(ctx.principal.owner_id, input.application, id);
        if (!version || version.owner_id !== ctx.principal.owner_id || version.application !== input.application || version.version_id !== id || !isVersionReady(version)) {
          versions.push(null); missing.push(`version:${id}:UNVERIFIED`);
        } else versions.push(structuredClone(version));
      }
      if (!frozen) missing.push(`input:${input.input_ref}:UNVERIFIED`);
      if (!options.replay) missing.push("replay-adapter:not-configured");
      for (const version of versions) {
        if (!version || !frozen) continue;
        const tool = version.tools.find((t) => t.name === frozen.tool);
        if (!tool || !tool.effects.read_only || tool.effects.destructive) missing.push(`tool:${version.version_id}:unsafe-or-missing`);
      }
      // This MANAGEMENT operation authorizes only internal, safe, pinned trials. It grants no public USER capability.
      for (const version of versions) if (version && frozen) assertTrialScope(ctx, version, frozen.tool);
      const initial = Evaluation.parse({ schema_version: 1, owner_id: ctx.principal.owner_id, created_at: new Date().toISOString(),
        provenance: provenanceOf("flywheel", ctx.principal), completeness: missing.length ? { status: "partial", missing_refs: [], notes: missing } : COMPLETE,
        evaluation_id: newId("evaluation"), application: input.application, version_ids: input.version_ids, input_ref: input.input_ref,
        criterion_ref: input.criterion_ref, config_ref: input.config_ref, idempotency_key: input.idempotency_key, state: "queued", results: [], missing_items: missing, recommendation_refs: [] });
      // Exact version snapshots include artifact/schema/auth identity; frozen before the first replay.
      const claim = await claimEvaluation(db, initial, requestDigest, { request: input, input: frozen, versions, config: structuredClone(config), criterion: "canonical-output-equality-v1" }, [...versions.flatMap((v) => v ? [v.source.repo_id] : []), ...(frozen ? [frozen.repoId] : [])]);
      if (!claim.created) return { evaluation_id: claim.evaluation.evaluation_id, state: claim.evaluation.state };
      let evaluation = claim.evaluation;
      await linkEvaluation(db, evaluation);
      if (missing.length || !frozen || !options.replay) {
        evaluation = await updateEvaluation(db, evaluation, { ...evaluation, state: "failed" });
        return { evaluation_id: evaluation.evaluation_id, state: evaluation.state };
      }
      active.add(evaluation.evaluation_id);
      try {
        evaluation = await updateEvaluation(db, evaluation, { ...evaluation, state: "running" });
        for (const version of versions) {
          if (!version) continue;
          let result: Evaluation["results"][number] = { version_id: version.version_id, call_ref: null, task_outcome: "unknown", latency_ms: null, cost_usd: null, detail: "UNVERIFIED: no durable call completion." };
          const armMissing: string[] = [];
          try {
            const response = await options.replay(ctx, { application: input.application, version: version.version_id, tool: frozen.tool,
              args: structuredClone(frozen.args), idempotency_key: `${evaluation.evaluation_id}:${version.version_id}`,
              evaluation_id: evaluation.evaluation_id, input_ref: input.input_ref, input_digest: frozen.digest,
              version_digest: canonicalDigest(version), schema_digest: version.schema_digest, fixture_state_ref: config.fixtureStateRef });
            const call = await options.getCall(db, evaluation.owner_id, response.call_ref);
            if (!call || call.owner_id !== evaluation.owner_id || call.application !== input.application || call.resolved_version !== version.version_id || call.schema_digest !== version.schema_digest || call.tool !== frozen.tool || call.grant_id !== ctx.grant.grant_id) {
              armMissing.push(`call:${version.version_id}:identity-unverified`);
            } else {
              result.call_ref = call.call_id;
              result.latency_ms = call.duration_ms;
              const evidence = call.output_ref ? await options.getEvidence(db, evaluation.owner_id, call.output_ref) : null;
              const recordedInput = call.input_ref ? await options.getEvidence(db, evaluation.owner_id, call.input_ref) : null;
              const argsMatch = recordedInput && !recordedInput.truncated && !recordedInput.redacted_paths.length && recordedInput.content_json && canonicalJson(JSON.parse(recordedInput.content_json)) === canonicalJson(frozen.args);
              if (!argsMatch) armMissing.push(`call:${call.call_id}:input-unverified`);
              else if (call.outcome === "unknown" || call.completeness.status !== "complete") armMissing.push(`call:${call.call_id}:completion-missing`);
              else if (call.outcome !== "success") result = { ...result, task_outcome: "error", detail: `Actual recorded call outcome: ${call.outcome}.` };
              else if (!evidence || evidence.kind !== "call_output" || evidence.truncated || evidence.redacted_paths.length || evidence.completeness.status !== "complete") armMissing.push(`call:${call.call_id}:output-unverified`);
              else {
                const actual: unknown = JSON.parse(evidence.content_json);
                result = { ...result, task_outcome: expectedOutputCriterion(actual, config.expectedOutput), detail: "Canonical tool output compared with the frozen configured expected output; agent-visible input and cost are unmeasured." };
              }
              if (result.latency_ms === null) armMissing.push(`call:${call.call_id}:latency-unmeasured`);
            }
          } catch (error) {
            if (error instanceof FlywheelError && error.shape.code === "storage_unavailable") throw error;
            result.detail = error instanceof FlywheelError ? `UNVERIFIED: ${error.shape.code}; no replay was retried.` : "UNVERIFIED: replay or evidence lookup failed; no replay was retried.";
            armMissing.push(`arm:${version.version_id}:outcome-unverified`);
          }
          evaluation = await updateEvaluation(db, evaluation, { ...evaluation, results: [...evaluation.results, result], missing_items: [...evaluation.missing_items, ...armMissing] });
          await linkEvaluation(db, evaluation);
        }
        const incomplete = evaluation.missing_items.length > 0 || evaluation.results.length !== input.version_ids.length;
        evaluation = await updateEvaluation(db, evaluation, { ...evaluation, state: incomplete ? "failed" : "completed",
          completeness: incomplete ? { status: "partial", missing_refs: [], notes: evaluation.missing_items } : COMPLETE });
        await linkEvaluation(db, evaluation);
      } finally { active.delete(evaluation.evaluation_id); }
      return { evaluation_id: evaluation.evaluation_id, state: evaluation.state };
    },
    async get_experiment(ctx, raw) {
      authorize(ctx, "get_experiment");
      const input = GetExperimentInput.parse(raw);
      let evaluation = await authorizedEvaluation(ctx, input.evaluation_id);
      if (["running", "queued"].includes(evaluation.state) && !active.has(evaluation.evaluation_id)) {
        evaluation = await updateEvaluation(db, evaluation, { ...evaluation, state: "failed",
          missing_items: [...evaluation.missing_items, "interrupted-comparison:remaining-arms-UNVERIFIED:no-automatic-replay"],
          completeness: { status: "unknown", missing_refs: [], notes: ["Manager restarted or trial ownership is unavailable. Saved calls remain evidence; no arm was retried."] } });
      }
      return { evaluation };
    },
    async recommend_candidate(ctx, raw) {
      authorize(ctx, "recommend_candidate");
      const input = RecommendCandidateInput.parse(raw);
      const evaluations = await Promise.all(input.evaluation_ids.map((id) => authorizedEvaluation(ctx, id)));
      const app = evaluations[0]!.application;
      if (evaluations.some((e) => e.application !== app || e.state !== "completed" || e.missing_items.length || e.completeness.status !== "complete")) throw new FlywheelError("invalid_args", "Recommendations require complete comparisons for one application with no unverified arms.");
      for (const id of input.version_ids) {
        if (evaluations.some((e) => !e.version_ids.includes(id) || !e.results.some((r) => r.version_id === id && r.task_outcome === "pass" && r.call_ref !== null))) throw new FlywheelError("invalid_args", "Every recommended version must have a recorded criterion pass in every cited comparison.");
      }
      const recommendation = Recommendation.parse({ schema_version: 1, owner_id: ctx.principal.owner_id, created_at: new Date().toISOString(),
        provenance: provenanceOf("flywheel", ctx.principal), completeness: COMPLETE, recommendation_id: newId("recommendation"), application: app,
        evaluation_ids: input.evaluation_ids, version_ids: input.version_ids, reason: input.reason });
      const repoIds = new Set<string>();
      for (const evaluation of evaluations) {
        const snapshot = TrialSnapshot.parse(await getEvaluationSnapshot(db, evaluation.owner_id, evaluation.evaluation_id));
        if (snapshot.input) repoIds.add(snapshot.input.repoId);
        for (const version of snapshot.versions) if (version) repoIds.add(version.source.repo_id);
      }
      const saved = await insertRecommendation(db, recommendation, canonicalDigest(input), [...repoIds]);
      for (let evaluation of evaluations) {
        if (!evaluation.recommendation_refs.includes(saved.recommendation_id)) evaluation = await updateEvaluation(db, evaluation, { ...evaluation, recommendation_refs: [...evaluation.recommendation_refs, saved.recommendation_id] });
        await linkEvaluation(db, evaluation);
      }
      return { recommendation_ref: saved.recommendation_id };
    },
  };
}


function assertTrialToolAllowed(ctx: OperationContext, application: string, toolName: string): void {
  const allowed = ctx.grant.allow.tools[application];
  if (allowed && !allowed.includes(toolName)) throw new FlywheelError("forbidden", "The internal trial tool is outside this grant's explicit app/tool scope.");
}
function assertTrialScope(ctx: OperationContext, version: Version, toolName: string): void {
  authorize(ctx, "run_experiment", version.application);
  assertRepoAllowed(ctx.grant, version.source.repo_id);
  assertTrialToolAllowed(ctx, version.application, toolName);
  const tool = version.tools.find((candidate) => candidate.name === toolName);
  if (version.owner_id !== ctx.principal.owner_id ||
      !tool || !tool.effects.read_only || tool.effects.destructive) {
    throw new FlywheelError("forbidden", "Internal trials require an owner/app/repository/tool-authorized, read-only non-destructive exact pin.");
  }
}
const TrialSnapshot = z.object({
  request: RunExperimentInput,
  input: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()), digest: z.string(), repoId: z.string() }).nullable(),
  versions: z.array(VersionSchema.nullable()),
  config: z.object({ ref: z.string(), fixtureStateRef: z.string(), expectedOutput: z.unknown(), maxVersions: z.number() }),
  criterion: z.literal("canonical-output-equality-v1"),
});
export interface TrustedExperimentReplayOptions {
  db: GraphClient;
  recorder: CallRecorder;
  getVersion(ownerId: string, application: string, exactVersionId: string): Promise<Version | null>;
  /** Composition supplies its SDK transport. This boundary never imports the gateway or accepts bearer headers. */
  invokePinned(version: Version, tool: string, args: Record<string, unknown>): Promise<{ isError?: boolean; [key: string]: unknown }>;
}
/** Server-internal comparison transport. Re-reads persisted authorization/evidence and never changes a grant. */
export function createTrustedExperimentReplay(options: TrustedExperimentReplayOptions): NonNullable<ExperimentServiceOptions["replay"]> {
  const active = new Map<string, Promise<DispatchOutput>>();
  return async (ctx, request) => {
    authorize(ctx, "run_experiment", request.application);
    const evaluation = await getEvaluation(options.db, ctx.principal.owner_id, request.evaluation_id);
    const snapshot = TrialSnapshot.safeParse(await getEvaluationSnapshot(options.db, ctx.principal.owner_id, request.evaluation_id));
    if (!evaluation || !snapshot.success || evaluation.provenance.grant_id !== ctx.grant.grant_id || evaluation.state !== "running") {
      throw new FlywheelError("forbidden", "Internal replay requires a running persisted comparison owned by this management grant.");
    }
    const frozen = snapshot.data;
    const pin = frozen.versions.find((version) => version?.version_id === request.version);
    if (!frozen.input || !pin || frozen.request.application !== request.application || evaluation.application !== request.application ||
        evaluation.input_ref !== request.input_ref || frozen.request.input_ref !== request.input_ref ||
        frozen.input.digest !== request.input_digest || frozen.input.tool !== request.tool ||
        canonicalJson(frozen.input.args) !== canonicalJson(request.args) || canonicalDigest(pin) !== request.version_digest ||
        pin.schema_digest !== request.schema_digest || frozen.config.fixtureStateRef !== request.fixture_state_ref ||
        request.idempotency_key !== `${evaluation.evaluation_id}:${pin.version_id}`) {
      throw new FlywheelError("forbidden", "Internal trial differs from its persisted exact version, frozen input, configuration or idempotency identity.");
    }
    assertRepoAllowed(ctx.grant, frozen.input.repoId);
    assertTrialScope(ctx, pin, request.tool);
    const current = await options.getVersion(evaluation.owner_id, evaluation.application, pin.version_id);
    if (!current || canonicalDigest(current) !== canonicalDigest(pin) || !isVersionReady(current)) {
      throw new FlywheelError("version_unavailable", "The immutable comparison version identity or verified readiness changed; no fallback is allowed.");
    }
    const key = canonicalJson([ctx.principal.owner_id, ctx.grant.grant_id, request.idempotency_key]);
    const previousWork = active.get(key);
    if (previousWork) await previousWork.catch(() => undefined);
    const work = execute();
    active.set(key, work);
    try { return await work; } finally { if (active.get(key) === work) active.delete(key); }
    async function execute(): Promise<DispatchOutput> {
      const prior = await options.recorder.findIdempotent(ctx.principal, request.application, request.tool, request.idempotency_key);
      if (prior) {
        if (prior.call.owner_id !== ctx.principal.owner_id || prior.call.grant_id !== ctx.grant.grant_id || prior.call.resolved_version !== pin!.version_id ||
            prior.call.schema_digest !== pin!.schema_digest || prior.args_digest !== canonicalDigest(request.args) || prior.call.requested_version !== pin!.version_id) {
          throw new FlywheelError("idempotency_conflict", "Internal trial key identifies a different recorded invocation.");
        }
        return { call_ref: prior.call.call_id, application: request.application, resolved_version: pin!.version_id, outcome: prior.call.outcome,
          completeness: prior.call.completeness, ...(prior.result === undefined ? {} : { result: prior.result }), ...(prior.call.error ? { error: prior.call.error } : {}) };
      }
      const { call_id } = await options.recorder.admit({ principal: ctx.principal, application: request.application, tool: request.tool,
        requested_version: pin!.version_id, resolved_version: pin!.version_id, schema_digest: pin!.schema_digest,
        idempotency_key: request.idempotency_key, args: structuredClone(frozen.input!.args), causal_refs: request.input_ref.startsWith("call_") ? [request.input_ref] : [] });
      const started = performance.now();
      let completion: CallCompletion;
      try {
        const result = await options.invokePinned(pin!, request.tool, structuredClone(frozen.input!.args));
        completion = { outcome: result.isError ? "tool_error" : "success", result,
          error: result.isError ? new FlywheelError("upstream_error", "The exact pinned trial returned a tool error.", { certainty: "executed", retryable: false }).shape : null, duration_ms: 0 };
      } catch (error) {
        const failure = error instanceof FlywheelError ? error : new FlywheelError("outcome_unknown", "Pinned trial lost its result; no automatic retry is permitted.");
        completion = { outcome: failure.shape.outcome_certainty === "unknown" ? "unknown" : "infra_error", error: failure.shape, duration_ms: 0 };
      }
      completion.duration_ms = Math.max(0, Math.round(performance.now() - started));
      await options.recorder.complete(call_id, completion);
      return { call_ref: call_id, application: request.application, resolved_version: pin!.version_id, outcome: completion.outcome,
        completeness: completion.outcome === "unknown" ? { status: "unknown", missing_refs: [call_id], notes: ["Trial outcome unknown; do not retry."] } : COMPLETE,
        ...(completion.result === undefined ? {} : { result: completion.result }), ...(completion.error ? { error: completion.error } : {}) };
    }
  };
}
