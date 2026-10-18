/**
 * Single shared contract source for MCP Flywheel (Linear TOO-65).
 *
 * Every module imports records, operation payloads, errors, grants and limits
 * from here. Do not define a second payload shape elsewhere; change this file
 * and docs/contracts.md together.
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------ limits */

/** Bounded defaults chosen by the implementer; rationale in docs/contracts.md. */
export const LIMITS = {
  maxRefsPerRequest: 20,
  defaultPageSize: 20,
  maxPageSize: 50,
  maxTextChars: 4000,
  maxChangeSummaryChars: 2000,
  maxEvidenceBytes: 16_384,
  maxIdempotencyKeyChars: 200,
  dispatchTimeoutMs: 30_000,
  maxExperimentVersions: 4,
} as const;

/* --------------------------------------------------------------------- ids */

export const ID_PREFIXES = {
  call: "call",
  event: "evt",
  evidence: "evd",
  feedback: "fb",
  packet: "pkt",
  job: "job",
  version: "ver",
  evaluation: "eval",
  recommendation: "rec",
  decision: "dec",
  grant: "grant",
} as const;
export type IdKind = keyof typeof ID_PREFIXES;

/** `<prefix>_<10 base36 time chars><16 hex random>`: unique and roughly time-sortable. */
export function newId(kind: IdKind): string {
  const time = Date.now().toString(36).padStart(10, "0");
  return `${ID_PREFIXES[kind]}_${time}${randomBytes(8).toString("hex")}`;
}

export function idKindOf(ref: string): IdKind | undefined {
  const prefix = ref.split("_", 1)[0];
  return (Object.keys(ID_PREFIXES) as IdKind[]).find((k) => ID_PREFIXES[k] === prefix);
}

const idOf = (kind: IdKind) =>
  z.string().regex(new RegExp(`^${ID_PREFIXES[kind]}_[0-9a-z]{26}$`), `expected a ${kind} id`);

export const CallId = idOf("call");
export const EventId = idOf("event");
export const EvidenceId = idOf("evidence");
export const FeedbackId = idOf("feedback");
export const PacketId = idOf("packet");
export const JobId = idOf("job");
export const VersionId = idOf("version");
export const EvaluationId = idOf("evaluation");
export const RecommendationId = idOf("recommendation");
export const DecisionId = idOf("decision");
export const GrantId = idOf("grant");

/** Any record ref accepted by evidence reads. */
export const AnyRef = z.string().min(3).max(64);

/** Application slugs. `flywheel` is reserved for the internal application. */
export const ApplicationName = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, "lowercase slug");
export const FLYWHEEL_APP = "flywheel" as const;

/** Version selector: an exact version_id or a per-application label such as `v2`. */
export const VersionSelector = z.string().min(1).max(64);
export const VersionLabel = z.string().regex(/^[a-z0-9][a-z0-9.-]{0,31}$/);

export const Sha = z.string().regex(/^[0-9a-f]{40}$/, "full 40-char git sha");
export const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const IdempotencyKey = z.string().min(1).max(LIMITS.maxIdempotencyKeyChars);
export const Timestamp = z.string().datetime({ offset: true });

/* -------------------------------------------------------- canonical digest */

/** Canonical JSON: UTF-8, object keys sorted, no whitespace, `undefined` dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("canonicalJson: non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** `sha256:<hex>` of canonical JSON after removing the excluded top-level fields. */
export function canonicalDigest(value: Record<string, unknown>, exclude: readonly string[] = []): string {
  const copy = Object.fromEntries(Object.entries(value).filter(([k]) => !exclude.includes(k)));
  return `sha256:${createHash("sha256").update(canonicalJson(copy), "utf8").digest("hex")}`;
}

/** Fields never included in record digests (identity/time/provenance are not content). */
export const DIGEST_EXCLUDED_FIELDS = ["schema_version", "created_at", "provenance", "digest"] as const;

/* ------------------------------------------------------------------ errors */

export const ErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_args",
  "storage_unavailable",
  "version_unavailable",
  "operation_unavailable",
  "outcome_unknown",
  "ingest_conflict",
  "idempotency_conflict",
  "stale_expected_current",
  "upstream_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Whether the requested side effect happened. */
export const OutcomeCertainty = z.enum(["not_executed", "executed", "unknown"]);

export const FlywheelErrorShape = z.object({
  code: ErrorCode,
  message: z.string(),
  field_path: z.string().optional(),
  retryable: z.boolean(),
  outcome_certainty: OutcomeCertainty,
});
export type FlywheelErrorShape = z.infer<typeof FlywheelErrorShape>;

const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["storage_unavailable", "upstream_error", "outcome_unknown"]);

/** Throwable carrier for FlywheelErrorShape. */
export class FlywheelError extends Error {
  readonly shape: FlywheelErrorShape;
  constructor(
    code: ErrorCode,
    message: string,
    opts: { fieldPath?: string; certainty?: z.infer<typeof OutcomeCertainty>; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "FlywheelError";
    this.shape = {
      code,
      message,
      ...(opts.fieldPath ? { field_path: opts.fieldPath } : {}),
      retryable: opts.retryable ?? RETRYABLE.has(code),
      outcome_certainty: opts.certainty ?? (code === "outcome_unknown" ? "unknown" : "not_executed"),
    };
  }
}

/* ------------------------------------------------------ shared record parts */

export const CompletenessStatus = z.enum(["complete", "partial", "unknown"]);
export const Completeness = z.object({
  status: CompletenessStatus,
  missing_refs: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type Completeness = z.infer<typeof Completeness>;
export const COMPLETE: Completeness = { status: "complete", missing_refs: [], notes: [] };

export const Recorder = z.enum(["gateway", "flywheel", "manager", "runner", "owner_cli", "seed"]);
export const Provenance = z.object({
  recorded_by: Recorder,
  subject: z.string().nullable(),
  client_id: z.string().nullable(),
  grant_id: z.string().nullable(),
  session_id: z.string().nullable(),
});
export type Provenance = z.infer<typeof Provenance>;

const recordBase = {
  schema_version: z.literal(SCHEMA_VERSION),
  owner_id: z.string().min(1),
  created_at: Timestamp,
  provenance: Provenance,
  completeness: Completeness,
};

/* ------------------------------------------------- grants and principals */

export const ToolGroup = z.enum(["user", "development", "management"]);
export type ToolGroup = z.infer<typeof ToolGroup>;

/**
 * Composable server-side grant. Groups are presets; every operation still
 * checks the app/tool/repo allowlists. Human merge/activate/rollback are not
 * reachable from any grant (owner CLI only).
 */
export const Grant = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  grant_id: GrantId,
  owner_id: z.string().min(1),
  label: z.string().min(1).max(80),
  groups: z.array(ToolGroup).min(1),
  allow: z.object({
    /** Application names, or ["*"] for every owner application. */
    apps: z.array(z.string()).min(1),
    /** Optional per-application inner tool allowlist; absent app key = all tools of that app. */
    tools: z.record(z.string(), z.array(z.string())).default({}),
    /** Repo ids start_job may target. */
    repos: z.array(z.string()).default([]),
  }),
  /** Narrows development reads to one job's packet evidence (per-job coding grant). */
  scope: z
    .object({ job_id: JobId.optional(), packet_id: PacketId.optional() })
    .default({}),
  created_at: Timestamp,
  revoked_at: Timestamp.nullable().default(null),
});
export type Grant = z.infer<typeof Grant>;

/** Authenticated caller. Built only from verified tokens, never from tool args. */
export const Principal = z.object({
  owner_id: z.string().min(1),
  subject: z.string().min(1),
  client_id: z.string().min(1),
  grant_id: GrantId,
  session_id: z.string().nullable(),
});
export type Principal = z.infer<typeof Principal>;

export function provenanceOf(recordedBy: z.infer<typeof Recorder>, p: Principal | null): Provenance {
  return {
    recorded_by: recordedBy,
    subject: p?.subject ?? null,
    client_id: p?.client_id ?? null,
    grant_id: p?.grant_id ?? null,
    session_id: p?.session_id ?? null,
  };
}

/* --------------------------------------------------------------- outer API */

export const ToolEffects = z.object({
  read_only: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  open_world: z.boolean(),
});
export type ToolEffects = z.infer<typeof ToolEffects>;

export const InnerTool = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.string(), z.unknown()),
  effects: ToolEffects,
});
export type InnerTool = z.infer<typeof InnerTool>;

export const ListAppsInput = z.object({}).strict();
export const ListAppsOutput = z.object({
  apps: z.array(
    z.object({
      application: ApplicationName,
      stable_version: z.string().nullable(),
      description: z.string(),
    }),
  ),
  completeness: Completeness,
});

export const DescribeInput = z.object({ application: ApplicationName, version: VersionSelector.optional() }).strict();
export const DescribeOutput = z.object({
  application: ApplicationName,
  resolved_version: z.string(),
  schema_digest: Digest,
  tools: z.array(InnerTool),
});

export const DispatchInput = z
  .object({
    application: ApplicationName,
    version: VersionSelector.optional(),
    tool: z.string().min(1).max(128),
    args: z.record(z.string(), z.unknown()).default({}),
    idempotency_key: IdempotencyKey.optional(),
  })
  .strict();

/** Tool-level outcome only. `success` is not evidence of user task success. */
export const CallOutcome = z.enum(["success", "tool_error", "protocol_error", "infra_error", "cancelled", "unknown"]);
export type CallOutcome = z.infer<typeof CallOutcome>;

export const DispatchOutput = z.object({
  call_ref: CallId,
  application: ApplicationName,
  resolved_version: z.string(),
  outcome: CallOutcome,
  result: z.unknown().optional(),
  error: FlywheelErrorShape.optional(),
  completeness: Completeness,
});

export type ListAppsInput = z.infer<typeof ListAppsInput>;
export type ListAppsOutput = z.infer<typeof ListAppsOutput>;
export type DescribeInput = z.infer<typeof DescribeInput>;
export type DescribeOutput = z.infer<typeof DescribeOutput>;
export type DispatchInput = z.infer<typeof DispatchInput>;
export type DispatchOutput = z.infer<typeof DispatchOutput>;

/* ----------------------------------------------------------------- records */

export const Application = z.object({
  ...recordBase,
  application: ApplicationName,
  description: z.string(),
  kind: z.enum(["upstream", "builtin"]),
});
export type Application = z.infer<typeof Application>;

export const RuntimeTarget = z.object({
  kind: z.literal("mcp_streamable_http"),
  /** Deployment-unique URL; never a mutable branch alias. */
  url: z.string().url(),
  deployment_id: z.string().nullable(),
  environment: z.enum(["local", "preview", "production"]),
});

export const VersionState = z.enum(["pending_checks", "ready", "failed", "unavailable"]);
export const READINESS_CHECKS = ["deployment_ready", "provenance_verified", "schema_verified", "auth_verified"] as const;

export const Version = z.object({
  ...recordBase,
  version_id: VersionId,
  /** sha256 over canonical {application,parent_version_id,source,schema_digest,runtime_target,auth_config_ref}. */
  digest: Digest,
  application: ApplicationName,
  label: VersionLabel,
  parent_version_id: VersionId.nullable(),
  source: z.object({ repo_id: z.string(), commit_sha: Sha }),
  /** Inner tool catalog snapshot read from the artifact at registration; schema_digest = canonicalDigest({tools}). */
  tools: z.array(InnerTool),
  schema_digest: Digest,
  runtime_target: RuntimeTarget,
  /** Name of a server-side credential reference; never the secret itself. */
  auth_config_ref: z.string().nullable(),
  verified_provenance: z.object({
    method: z.enum(["owner_config", "manager_verified"]),
    job_id: JobId.nullable(),
    packet_id: PacketId.nullable(),
  }),
  state: VersionState,
  readiness: z.object(Object.fromEntries(READINESS_CHECKS.map((c) => [c, z.boolean()])) as {
    [K in (typeof READINESS_CHECKS)[number]]: z.ZodBoolean;
  }),
});
export type Version = z.infer<typeof Version>;
export const VERSION_DIGEST_FIELDS = [
  "application",
  "parent_version_id",
  "source",
  "schema_digest",
  "runtime_target",
  "auth_config_ref",
] as const;

/** Stored separately from versions; changed only by owner CLI decisions. */
export const StablePointer = z.object({
  application: ApplicationName,
  version_id: VersionId,
  decision_id: DecisionId.nullable(),
  updated_at: Timestamp,
});
export type StablePointer = z.infer<typeof StablePointer>;

/** Sanitized, bounded payload captured for a call or feedback. */
export const Evidence = z.object({
  ...recordBase,
  evidence_id: EvidenceId,
  kind: z.enum(["call_input", "call_output", "feedback_text"]),
  content_json: z.string().max(LIMITS.maxEvidenceBytes),
  truncated: z.boolean(),
  redacted_paths: z.array(z.string()),
  digest: Digest,
});
export type Evidence = z.infer<typeof Evidence>;

export const Call = z.object({
  ...recordBase,
  call_id: CallId,
  subject: z.string(),
  session_id: z.string().nullable(),
  run_id: z.string().nullable(),
  client_id: z.string(),
  grant_id: GrantId,
  application: ApplicationName,
  tool: z.string(),
  requested_version: z.string().nullable(),
  resolved_version: z.string(),
  schema_digest: Digest,
  idempotency_key: IdempotencyKey.nullable(),
  input_ref: EvidenceId.nullable(),
  output_ref: EvidenceId.nullable(),
  causal_refs: z.array(z.string()),
  /** Missing completion is always `unknown`. */
  outcome: CallOutcome,
  error: FlywheelErrorShape.nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
});
export type Call = z.infer<typeof Call>;

/** Admission and completion are separate events; same event_id + same content is a no-op. */
export const CallEvent = z.object({
  event_id: EventId,
  call_id: CallId,
  kind: z.enum(["admission", "completion"]),
  at: Timestamp,
  content_digest: Digest,
});
export type CallEvent = z.infer<typeof CallEvent>;

export const FeedbackSignal = z.enum(["positive", "negative", "mixed"]);
export const Feedback = z.object({
  ...recordBase,
  feedback_id: FeedbackId,
  call_refs: z.array(CallId).min(1),
  source: z.enum(["explicit", "inferred"]),
  signal: FeedbackSignal,
  observed: z.string().max(LIMITS.maxTextChars).nullable(),
  expected: z.string().max(LIMITS.maxTextChars).nullable(),
  text_ref: EvidenceId.nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  evidence_refs: z.array(z.string()),
  idempotency_key: IdempotencyKey.nullable(),
  /** Digest of the submitted content; same key + different digest -> idempotency_conflict. */
  content_digest: Digest,
});
export type Feedback = z.infer<typeof Feedback>;

/** Frozen improvement packet. Its suggestions are untrusted and grant nothing. */
export const Packet = z.object({
  ...recordBase,
  packet_id: PacketId,
  /** canonicalDigest(packet, PACKET_DIGEST_EXCLUDED) — identical content -> same logical packet. */
  digest: Digest,
  application: ApplicationName,
  parent_version_id: VersionId,
  source: z.object({ repo_id: z.string(), commit_sha: Sha }),
  call_refs: z.array(CallId),
  feedback_ids: z.array(FeedbackId),
  evidence_refs: z.array(z.string()),
  /** Snapshot copied at freeze time; later source changes do not alter it. */
  snapshot: z.object({
    calls: z.array(z.record(z.string(), z.unknown())),
    feedback: z.array(z.record(z.string(), z.unknown())),
    evidence: z.array(z.record(z.string(), z.unknown())),
  }),
  capture_policy: z.literal("sanitized-bounded-v1"),
  reproduction: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).nullable(),
  expected_outcome: z.string().nullable(),
  change_summary: z.string().max(LIMITS.maxChangeSummaryChars),
  successor_of: PacketId.nullable(),
  missing_refs: z.array(z.string()),
});
export type Packet = z.infer<typeof Packet>;
export const PACKET_DIGEST_EXCLUDED = [...DIGEST_EXCLUDED_FIELDS, "packet_id", "owner_id", "completeness"] as const;

export const JobState = z.enum(["queued", "launching", "running", "completed", "failed", "cancelled", "unknown"]);
export type JobState = z.infer<typeof JobState>;
/** Allowed transitions. `unknown` is resolved only by reconcile, never by a blind resubmit. */
export const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ["launching", "failed", "cancelled"],
  launching: ["running", "failed", "unknown"],
  running: ["completed", "failed", "cancelled", "unknown"],
  unknown: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export const Job = z.object({
  ...recordBase,
  job_id: JobId,
  application: ApplicationName,
  repo_id: z.string(),
  base_sha: Sha,
  packet_id: PacketId,
  runner_config_id: z.string(),
  submission_key: IdempotencyKey,
  state: JobState,
  /** Trusted runner-start evidence (process spawn), never model self-report. */
  external_receipt: z
    .object({ runner: z.string(), run_id: z.string(), pid: z.number().int().nullable(), started_at: Timestamp })
    .nullable(),
  workspace_ref: z.string().nullable(),
  result: z
    .object({
      branch: z.string(),
      commit_sha: Sha,
      artifact_ref: z.string(),
      change_summary: z.string().max(LIMITS.maxChangeSummaryChars),
      checks: z.array(z.object({ name: z.string(), outcome: z.enum(["pass", "fail", "skipped"]) })),
      /** Untrusted request from the subprocess; not deployment authority. */
      requested_deployment: z.record(z.string(), z.unknown()).nullable(),
    })
    .nullable(),
  deployment: z
    .object({
      deployment_id: z.string(),
      url: z.string().url(),
      project_id: z.string(),
      commit_sha: Sha,
      target: z.literal("preview"),
      ready_at: Timestamp,
    })
    .nullable(),
  version_id: VersionId.nullable(),
  error: FlywheelErrorShape.nullable(),
});
export type Job = z.infer<typeof Job>;

export const TaskOutcome = z.enum(["pass", "fail", "error", "unknown"]);
export const Evaluation = z.object({
  ...recordBase,
  evaluation_id: EvaluationId,
  application: ApplicationName,
  version_ids: z.array(VersionId).min(2),
  input_ref: z.string(),
  criterion_ref: z.string(),
  config_ref: z.string(),
  idempotency_key: IdempotencyKey,
  state: z.enum(["queued", "running", "completed", "failed"]),
  results: z.array(
    z.object({
      version_id: VersionId,
      call_ref: CallId.nullable(),
      task_outcome: TaskOutcome,
      latency_ms: z.number().int().nonnegative().nullable(),
      cost_usd: z.number().nonnegative().nullable(),
      detail: z.string(),
    }),
  ),
  missing_items: z.array(z.string()),
  recommendation_refs: z.array(RecommendationId),
});
export type Evaluation = z.infer<typeof Evaluation>;

/** A recorded suggestion only; it never changes stable. */
export const Recommendation = z.object({
  ...recordBase,
  recommendation_id: RecommendationId,
  application: ApplicationName,
  evaluation_ids: z.array(EvaluationId).min(1),
  version_ids: z.array(VersionId).min(1),
  reason: z.string().max(LIMITS.maxTextChars),
});
export type Recommendation = z.infer<typeof Recommendation>;

/** Owner-CLI-only decisions. Merge and activation are always separate records. */
export const HumanDecisionKind = z.enum(["merge", "activate", "rollback"]);
export const HumanDecision = z.object({
  ...recordBase,
  decision_id: DecisionId,
  kind: HumanDecisionKind,
  application: ApplicationName,
  source: z.object({ repo_id: z.string(), commit_sha: Sha }).nullable(),
  selected_version_id: VersionId.nullable(),
  expected_current_version_id: VersionId.nullable(),
  receipt: z.record(z.string(), z.unknown()),
});
export type HumanDecision = z.infer<typeof HumanDecision>;

/* ----------------------------------------- internal `flywheel` application */

export const ReportFeedbackInput = z
  .object({
    call_refs: z.array(CallId).min(1).max(LIMITS.maxRefsPerRequest),
    signal: FeedbackSignal,
    observed: z.string().max(LIMITS.maxTextChars).optional(),
    expected: z.string().max(LIMITS.maxTextChars).optional(),
    text: z.string().max(LIMITS.maxTextChars).optional(),
    evidence_refs: z.array(AnyRef).max(LIMITS.maxRefsPerRequest).optional(),
    idempotency_key: IdempotencyKey.optional(),
  })
  .strict();
export const ReportFeedbackOutput = z.object({ feedback_id: FeedbackId, durable: z.literal(true) });

const pageInput = {
  limit: z.number().int().min(1).max(LIMITS.maxPageSize).optional(),
  cursor: z.string().max(200).optional(),
};

export const ContextItemKind = z.enum(["call", "feedback", "packet", "job", "version", "evaluation"]);
export const ContextItem = z.object({
  ref: z.string(),
  kind: ContextItemKind,
  created_at: Timestamp,
  /** Bounded metadata only; raw payloads require get_evidence. */
  summary: z.record(z.string(), z.unknown()),
});
export const LineageEdge = z.object({ from: z.string(), rel: z.string(), to: z.string() });

export const GetContextInput = z
  .object({ application: ApplicationName, version: VersionSelector.optional(), call_ref: CallId.optional(), ...pageInput })
  .strict();
export const GetContextOutput = z.object({
  items: z.array(ContextItem),
  lineage: z.array(LineageEdge),
  completeness: Completeness,
  next_cursor: z.string().nullable(),
});

export const GetEvidenceInput = z
  .object({ refs: z.array(AnyRef).min(1).max(LIMITS.maxRefsPerRequest), ...pageInput })
  .strict();
/** Unauthorized and nonexistent refs are both reported in missing_refs (no existence leak). */
export const GetEvidenceOutput = z.object({
  items: z.array(z.object({ ref: z.string(), kind: z.string(), record: z.record(z.string(), z.unknown()) })),
  missing_refs: z.array(z.string()),
  next_cursor: z.string().nullable(),
});

export const CreatePacketInput = z
  .object({
    call_refs: z.array(CallId).min(1).max(LIMITS.maxRefsPerRequest),
    feedback_ids: z.array(FeedbackId).max(LIMITS.maxRefsPerRequest),
    change_summary: z.string().min(1).max(LIMITS.maxChangeSummaryChars),
    evidence_refs: z.array(AnyRef).max(LIMITS.maxRefsPerRequest).optional(),
    successor_of: PacketId.optional(),
  })
  .strict();
/** Management ACK never carries raw evidence. */
export const CreatePacketOutput = z.object({ packet_id: PacketId, digest: Digest, missing_refs: z.array(z.string()) });

export const StartJobInput = z
  .object({
    repo_id: z.string().min(1),
    base_sha: Sha,
    packet_id: PacketId,
    runner_config_id: z.string().min(1),
    idempotency_key: IdempotencyKey,
  })
  .strict();
export const StartJobOutput = z.object({ job_id: JobId, state: JobState, receipt_ref: z.string().nullable() });

export const GetJobInput = z.object({ job_id: JobId }).strict();
export const GetJobOutput = z.object({ job: Job });

export const RegisterPreviewInput = z
  .object({
    job_id: JobId,
    application: ApplicationName,
    parent_version: VersionId,
    /** Must equal the job's verified result artifact_ref. */
    artifact_ref: z.string().min(1),
    /** Must equal the manager-verified deployment_id; caller URLs are never trusted. */
    deployment_ref: z.string().min(1),
  })
  .strict();
export const RegisterPreviewOutput = z.object({
  version_id: VersionId,
  state: VersionState,
  missing_checks: z.array(z.string()),
});

export const RunExperimentInput = z
  .object({
    application: ApplicationName,
    version_ids: z.array(VersionId).min(2).max(LIMITS.maxExperimentVersions),
    /** A call_id or packet_id whose reproduction input is replayed unchanged. */
    input_ref: z.string().min(1),
    /** Name of a built-in deterministic criterion, e.g. `criterion:expected-output`. */
    criterion_ref: z.string().min(1),
    /** Name of a built-in run config, e.g. `config:default`. */
    config_ref: z.string().min(1),
    idempotency_key: IdempotencyKey,
  })
  .strict();
export const RunExperimentOutput = z.object({
  evaluation_id: EvaluationId,
  state: z.enum(["queued", "running", "completed", "failed"]),
});
export const GetExperimentInput = z.object({ evaluation_id: EvaluationId }).strict();
export const GetExperimentOutput = z.object({ evaluation: Evaluation });

export const RecommendCandidateInput = z
  .object({
    evaluation_ids: z.array(EvaluationId).min(1).max(LIMITS.maxRefsPerRequest),
    version_ids: z.array(VersionId).min(1).max(LIMITS.maxExperimentVersions),
    reason: z.string().min(1).max(LIMITS.maxTextChars),
  })
  .strict();
export const RecommendCandidateOutput = z.object({ recommendation_ref: RecommendationId });

const ro: ToolEffects = { read_only: true, destructive: false, idempotent: true, open_world: false };
const write: ToolEffects = { read_only: false, destructive: false, idempotent: true, open_world: false };
const launch: ToolEffects = { read_only: false, destructive: false, idempotent: true, open_world: true };

/** Operation catalog of the internal `flywheel` application, keyed by tool name. */
export const FLYWHEEL_OPERATIONS = {
  report_feedback: {
    group: "user",
    effects: write,
    input: ReportFeedbackInput,
    output: ReportFeedbackOutput,
    description: "Record feedback about exact prior call refs. ACK only after a durable write.",
  },
  get_context: {
    group: "development",
    effects: ro,
    input: GetContextInput,
    output: GetContextOutput,
    description: "Bounded lineage of calls, feedback, packets, jobs and versions for one application.",
  },
  get_evidence: {
    group: "development",
    effects: ro,
    input: GetEvidenceInput,
    output: GetEvidenceOutput,
    description: "Authorized, bounded record details for refs (including packets); others are missing_refs.",
  },
  create_packet: {
    group: "management",
    effects: write,
    input: CreatePacketInput,
    output: CreatePacketOutput,
    description: "Freeze an immutable improvement packet from authorized refs. Returns id/digest only.",
  },
  start_job: {
    group: "management",
    effects: launch,
    input: StartJobInput,
    output: StartJobOutput,
    description: "Durably record and launch an isolated coding job for an allowlisted repo/base sha.",
  },
  get_job: {
    group: "management",
    effects: ro,
    input: GetJobInput,
    output: GetJobOutput,
    description: "Real state, receipts and result refs of one job.",
  },
  register_preview: {
    group: "management",
    effects: write,
    input: RegisterPreviewInput,
    output: RegisterPreviewOutput,
    description: "Register a manager-verified preview deployment as a new version. Never changes stable.",
  },
  run_experiment: {
    group: "management",
    effects: launch,
    input: RunExperimentInput,
    output: RunExperimentOutput,
    description: "Replay one input against pinned versions and score with a deterministic criterion.",
  },
  get_experiment: {
    group: "management",
    effects: ro,
    input: GetExperimentInput,
    output: GetExperimentOutput,
    description: "Results and missing items of one evaluation.",
  },
  recommend_candidate: {
    group: "management",
    effects: write,
    input: RecommendCandidateInput,
    output: RecommendCandidateOutput,
    description: "Record a candidate recommendation. Does not merge or activate anything.",
  },
} as const satisfies Record<
  string,
  { group: ToolGroup; effects: ToolEffects; input: z.ZodType; output: z.ZodType; description: string }
>;

export type FlywheelOperation = keyof typeof FLYWHEEL_OPERATIONS;
export type OpInput<K extends FlywheelOperation> = z.infer<(typeof FLYWHEEL_OPERATIONS)[K]["input"]>;
export type OpOutput<K extends FlywheelOperation> = z.infer<(typeof FLYWHEEL_OPERATIONS)[K]["output"]>;

/** Upstream (wrapped app) tools always belong to the user group. */
export const UPSTREAM_TOOL_GROUP: ToolGroup = "user";

/** Not reachable through any grant or dispatch; owner CLI only. */
export const HUMAN_ONLY_ACTIONS = HumanDecisionKind.options;

/* -------------------------------------------- gateway <-> flywheel seam */

/** Context the gateway passes to flywheel handlers after authenticating and authorizing. */
export interface OperationContext {
  principal: Principal;
  grant: Grant;
  /** Call record id of the outer dispatch that carries this operation. */
  call_id: string;
}

/**
 * Implemented by src/flywheel; mounted by src/gateway. The gateway enforces
 * group + app/tool allowlists before calling; handlers enforce data-level
 * scope (app ownership, job/packet scope, repo allowlist) and throw FlywheelError.
 * Operations not yet implemented are omitted: the gateway hides them from
 * describe and answers operation_unavailable on dispatch.
 */
export type FlywheelHandlers = {
  [K in FlywheelOperation]?: (ctx: OperationContext, input: OpInput<K>) => Promise<OpOutput<K>>;
};

/* ---------------------------------------- gateway <-> evidence store seam */

/** What the gateway knows at admission; the store sanitizes and bounds `args`. */
export interface CallAdmission {
  principal: Principal;
  application: string;
  tool: string;
  requested_version: string | null;
  resolved_version: string;
  schema_digest: string;
  idempotency_key: string | null;
  args: Record<string, unknown>;
  causal_refs: string[];
}

export interface CallCompletion {
  outcome: CallOutcome;
  result?: unknown;
  error: FlywheelErrorShape | null;
  duration_ms: number;
}

/**
 * Implemented by src/flywheel (TOO-67), called by src/gateway dispatch (TOO-64).
 * Every method throws FlywheelError("storage_unavailable") when FalkorDB did not
 * durably commit; the gateway then must not report success.
 */
export interface CallRecorder {
  /** Writes Call (outcome `unknown`), its admission CallEvent and input Evidence. */
  admit(admission: CallAdmission): Promise<{ call_id: string }>;
  /** Writes the completion CallEvent, output Evidence, and final outcome. */
  complete(call_id: string, completion: CallCompletion): Promise<void>;
  /**
   * Prior call by (owner, grant, application, tool, idempotency_key). Returns the
   * call and its args digest so the gateway can answer the same call_ref or raise
   * idempotency_conflict when the args differ.
   */
  findIdempotent(
    principal: Principal,
    application: string,
    tool: string,
    idempotency_key: string,
  ): Promise<{ call: Call; args_digest: string; result: unknown } | null>;
}
