import {
  FLYWHEEL_APP, FLYWHEEL_OPERATIONS, HUMAN_ONLY_ACTIONS, FlywheelError, canonicalDigest, canonicalJson,
  type CallCompletion, type DispatchInput, type DispatchOutput, type FlywheelHandlers, type FlywheelOperation,
  type OpInput, type OpOutput,
} from "../contracts.js";
import { getApplication } from "../db/registry.js";
import { assertCanDispatch, isFlywheelOperation } from "../policy.js";
import type { GatewayContext } from "./mcp.js";
import type { GatewayCoreOptions } from "./core.js";
import { assertContext, builtinDescription, catalogCompleteness, resolveVersion, validateToolArgs } from "./registry.js";
import { boundedTimeout, callUpstream, UpstreamProtocolError } from "./upstream.js";

type DispatchOptions = GatewayCoreOptions & { handlers: FlywheelHandlers };

/** Serializes same-key admissions in this core; the recorder owns durable dedup across processes. */
export function createDispatch(options: DispatchOptions) {
  const inFlight = new Map<string, Promise<DispatchOutput>>();
  return async (ctx: GatewayContext, input: DispatchInput): Promise<DispatchOutput> => {
    if (!input.idempotency_key) return dispatchCall(options, ctx, input);
    const key = canonicalJson([ctx.principal.owner_id, ctx.principal.grant_id, input.application, input.tool, input.idempotency_key]);
    const pending = inFlight.get(key);
    if (pending) {
      await pending.catch(() => undefined);
      return createAndTrack();
    }
    return createAndTrack();
    async function createAndTrack() {
      // Another waiter may have acquired this key while this request resumed.
      const current = inFlight.get(key);
      if (current) { await current.catch(() => undefined); return createAndTrack(); }
      const work = dispatchCall(options, ctx, input);
      inFlight.set(key, work);
      try { return await work; }
      finally { if (inFlight.get(key) === work) inFlight.delete(key); }
    }
  };
}

function output(callId: string, input: DispatchInput, version: string, completion: CallCompletion): DispatchOutput {
  return { call_ref: callId, application: input.application, resolved_version: version, outcome: completion.outcome,
    ...(completion.result === undefined ? {} : { result: completion.result }),
    ...(completion.error ? { error: completion.error } : {}), completeness: completion.outcome === "unknown" || completion.error?.outcome_certainty === "unknown"
      ? { status: "unknown", missing_refs: [], notes: ["The execution outcome is unknown; reconcile before retrying."] }
      : catalogCompleteness() };
}

async function recorded<T>(work: () => Promise<T>, certainty: "not_executed" | "executed" | "unknown"): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof FlywheelError && error.shape.code !== "storage_unavailable") throw error;
    throw new FlywheelError("storage_unavailable", "Call recording did not durably complete; reconcile before retrying.", { certainty });
  }
}

async function invokeHandler<K extends FlywheelOperation>(handlers: FlywheelHandlers, operation: K, ctx: GatewayContext, callId: string, args: unknown, timeoutMs: number): Promise<OpOutput<K>> {
  const spec = FLYWHEEL_OPERATIONS[operation];
  const handler = handlers[operation] as ((ctx: GatewayContext & { call_id: string }, args: OpInput<K>) => Promise<OpOutput<K>>) | undefined;
  if (!handler) throw new FlywheelError("operation_unavailable", "The selected operation is not implemented.");
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([handler({ ...ctx, call_id: callId }, args as OpInput<K>), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FlywheelError("outcome_unknown", "The internal operation exceeded its deadline; reconcile before retrying.")), timeoutMs);
    })]);
    const parsed = spec.output.safeParse(result);
    if (!parsed.success) throw new FlywheelError("upstream_error", "The internal handler returned an invalid contract payload.", { certainty: "executed", retryable: false });
    return parsed.data as OpOutput<K>;
  } finally { if (timer) clearTimeout(timer); }
}

export async function dispatchCall(options: DispatchOptions, ctx: GatewayContext, input: DispatchInput): Promise<DispatchOutput> {
  assertContext(ctx);
  assertCanDispatch(ctx.grant, input.application, input.tool, options.handlers);
  if (HUMAN_ONLY_ACTIONS.includes(input.tool as typeof HUMAN_ONLY_ACTIONS[number])) {
    throw new FlywheelError("forbidden", "Human decisions are available only through the owner CLI.", { fieldPath: "tool" });
  }
  if (input.application !== FLYWHEEL_APP && !await getApplication(options.db, ctx.principal.owner_id, input.application)) {
    throw new FlywheelError("not_found", "Application was not found.", { fieldPath: "application" });
  }
  if (input.idempotency_key) {
    const previous = await recorded(() => options.recorder.findIdempotent(ctx.principal, input.application, input.tool, input.idempotency_key!), "not_executed");
    if (previous) {
      const call = previous.call;
      if (call.owner_id !== ctx.principal.owner_id || call.grant_id !== ctx.principal.grant_id || call.application !== input.application || call.tool !== input.tool) {
        throw new FlywheelError("storage_unavailable", "Recorder returned a call outside the verified identity.");
      }
      if (previous.args_digest !== canonicalDigest(input.args) || call.requested_version !== (input.version ?? null)) {
        throw new FlywheelError("idempotency_conflict", "The idempotency key already belongs to different arguments or a different version selector.");
      }
      return { ...output(call.call_id, input, call.resolved_version, { outcome: call.outcome, result: previous.result,
        error: call.error ?? (call.outcome === "unknown" ? new FlywheelError("outcome_unknown", "The prior call has no certain completion; it will not be executed again.").shape : null), duration_ms: call.duration_ms ?? 0 }), completeness: call.completeness };
    }
  }
  const builtin = input.application === FLYWHEEL_APP;
  const version = builtin ? null : await resolveVersion(options.db, ctx.principal.owner_id, input.application, input.version);
  const description = builtin ? builtinDescription(ctx, options.handlers, input.version) : null;
  const tool = version?.tools.find((t) => t.name === input.tool) ?? description?.tools.find((t) => t.name === input.tool);
  if (!tool) throw new FlywheelError("operation_unavailable", "The tool is absent from the exact selected version.", { fieldPath: "tool" });
  validateToolArgs(tool, input.args);
  // Zod's strict input schemas remain authoritative for builtin operation payloads.
  if (builtin && isFlywheelOperation(input.tool)) {
    const parsed = FLYWHEEL_OPERATIONS[input.tool].input.safeParse(input.args);
    if (!parsed.success) throw new FlywheelError("invalid_args", parsed.error.issues[0]?.message ?? "Invalid operation input.", { fieldPath: "args" });
  }
  const resolved = version?.version_id ?? description!.resolved_version;
  const { call_id } = await recorded(() => options.recorder.admit({
    principal: ctx.principal, application: input.application, tool: input.tool, requested_version: input.version ?? null,
    resolved_version: resolved, schema_digest: version?.schema_digest ?? description!.schema_digest,
    idempotency_key: input.idempotency_key ?? null, args: structuredClone(input.args), causal_refs: [],
  }), "not_executed");
  const started = performance.now();
  let completion: CallCompletion;
  try {
    if (version) {
      const result = await callUpstream(version, input.tool, input.args, options);
      completion = { outcome: result.isError ? "tool_error" : "success", result,
        error: result.isError ? new FlywheelError("upstream_error", "The pinned upstream tool returned an error result.", { certainty: "executed", retryable: false }).shape : null,
        duration_ms: 0 };
    } else {
      const result = await invokeHandler(options.handlers, input.tool as FlywheelOperation, ctx, call_id, input.args, boundedTimeout(options.timeoutMs));
      completion = { outcome: "success", result, error: null, duration_ms: 0 };
    }
  } catch (error) {
    const failure = error instanceof FlywheelError ? error : new FlywheelError("outcome_unknown", "The operation failed without a certain outcome; reconcile the call before retrying.");
    completion = { outcome: error instanceof UpstreamProtocolError ? "protocol_error" : failure.shape.outcome_certainty === "unknown" ? "unknown" : "infra_error", error: failure.shape, duration_ms: 0 };
  }
  completion.duration_ms = Math.max(0, Math.round(performance.now() - started));
  const certainty = completion.error?.outcome_certainty ?? "executed";
  try { await recorded(() => options.recorder.complete(call_id, completion), certainty); }
  catch (error) {
    const failure = error instanceof FlywheelError ? error : new FlywheelError("storage_unavailable", "Call completion could not be persisted.", { certainty });
    return { ...output(call_id, input, resolved, { outcome: "unknown", error: failure.shape, duration_ms: completion.duration_ms }),
      completeness: { status: "unknown", missing_refs: [call_id], notes: ["Admission exists; completion persistence failed. Reconcile this call before retrying."] } };
  }
  return output(call_id, input, resolved, completion);
}
