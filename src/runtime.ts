import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { z } from "zod";
import path from "node:path";
import { createApp } from "./app.js";
import { credentialPostgresSecrets, type Config } from "./config.js";
import { createPostgresCredentialStore } from "./gateway/postgres-credentials.js";
import { FlywheelError, type CallRecorder } from "./contracts.js";
import { GraphClient } from "./db/client.js";
import { INDEX_SPECS, bootstrapSchema, readSchemaVersion } from "./db/schema.js";
import { REGISTRY_INDEX_SPECS } from "./db/registry.js";
import { EVIDENCE_INDEX_SPECS, getCall, getEvidence, getPacket } from "./db/evidence.js";
import { JOB_INDEX_SPECS } from "./db/jobs.js";
import { EXPERIMENT_INDEX_SPECS } from "./db/experiments.js";
import { RATE_LIMIT_INDEX_SPECS, createGraphRateLimitStore } from "./db/rate-limits.js";
import { issueTokenPair } from "./db/auth.js";
import { getVersion } from "./db/registry.js";
import { createEvidenceService, createJobService, createExperimentService, createTrustedExperimentReplay, createLocalRunner, createVercelManager,
  type JobServiceOptions, type ExperimentRunConfig, type RunnerConfig, type TrustedRepository,
  type RunnerAdapter, type ManagerAdapter } from "./flywheel/index.js";
import { createGatewayCore } from "./gateway/core.js";
import { mountGateway, type GatewayCore } from "./gateway/mcp.js";
import { createSupabaseAuth } from "./gateway/auth/supabase.js";
import { FlywheelOAuthProvider } from "./gateway/oauth/provider.js";
import { callUpstream, type UpstreamOptions } from "./gateway/upstream.js";
import { createPreviewRegistry, type PreviewRegistryProject } from "./gateway/registry.js";
import { createCredentialHelperStore, createEnvironmentCredentialStore, createCredentialMediator, OAuthCredential, type CredentialStore } from "./gateway/credentials.js";
import { createProtectedPreviewVerifier } from "./gateway/preview.js";
import { Lifecycle } from "./lifecycle.js";
import { configReadiness, type ReadinessItem } from "./readiness.js";
import { seedConfiguredFixtures } from "../fixtures/registry.js";

/** Later module indexes belong to the composition layer, never to the auth layer. */
export const RUNTIME_INDEX_SPECS = [
  ...INDEX_SPECS, ...REGISTRY_INDEX_SPECS, ...EVIDENCE_INDEX_SPECS,
  ...JOB_INDEX_SPECS, ...EXPERIMENT_INDEX_SPECS, ...RATE_LIMIT_INDEX_SPECS,
];

const FixtureConfig = z.object({
  baseUrl: z.url(),
  source: z.object({ repo_id: z.string().min(1), commit_sha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  initializeStable: z.boolean().default(false),
}).strict();

export const CredentialStoreConfiguration = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("environment") }).strict(),
  z.object({ kind: z.literal("postgres"), activeKeyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), tls: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal("helper"), executable: z.string().refine(path.isAbsolute),
    homeDirectory: z.string().refine(path.isAbsolute).optional() }).strict(),
]);

/** External credentials are resolved only in the trusted operator/manager process. */
export function createConfiguredCredentialStore(configuration: z.infer<typeof CredentialStoreConfiguration>, environment: NodeJS.ProcessEnv, requireRls = false): CredentialStore {
  if (configuration.kind === "postgres") return createPostgresCredentialStore({ ...configuration, ...credentialPostgresSecrets(environment), requireRls });
  return configuration.kind === "helper" ? createCredentialHelperStore(configuration) : createEnvironmentCredentialStore(environment);
}

const RuntimeFile = z.object({
  credentialStore: CredentialStoreConfiguration.optional(),
  vercelExecutable: z.string().refine(path.isAbsolute).optional(),
  workspaceRoot: z.string().refine(path.isAbsolute, "workspaceRoot must be absolute").optional(),
  repositories: z.array(z.object({ repoId: z.string().min(1), ownerId: z.string().min(1), application: z.string().min(1),
    localPath: z.string().refine(path.isAbsolute), allowedBaseShas: z.array(z.string().regex(/^[a-f0-9]{40}$/)), runnerConfigIds: z.array(z.string().min(1)) }).strict()).default([]),
  runnerConfigs: z.array(z.object({ id: z.string().min(1), executable: z.string().min(1), args: z.array(z.string()),
    environmentRefs: z.record(z.string(), z.string()).default({}), environmentAllowlist: z.array(z.string()),
    writablePaths: z.array(z.string()).min(1), readOnlyPaths: z.array(z.string()).optional(),
    checks: z.array(z.object({ name: z.string(), executable: z.string(), args: z.array(z.string()) }).strict()),
    timeoutMs: z.number().int().min(1).max(3_600_000), network: z.boolean().default(false) }).strict()).default([]),
  previewProjects: z.array(z.object({ ownerId: z.string().min(1), application: z.string().min(1), repoId: z.string().min(1),
    providerRepoId: z.string().min(1), projectId: z.string().min(1), teamId: z.string().min(1), mcpPath: z.string().startsWith("/"),
    authConfigRef: z.string().min(1), issuer: z.url(), scopes: z.array(z.string().min(1)).min(1) }).strict()).default([]),
  experimentConfigs: z.array(z.object({ ref: z.string().min(1), fixtureStateRef: z.string().min(1),
    expectedOutput: z.unknown(), maxVersions: z.number().int().min(2).max(4) }).strict()).default([]),
}).passthrough();

export interface RuntimeIntegrations extends UpstreamOptions {
  repositories?: readonly TrustedRepository[];
  runnerConfigs?: readonly RunnerConfig[];
  experimentConfigs?: readonly ExperimentRunConfig[];
  runner?: RunnerAdapter;
  manager?: ManagerAdapter;
  registerPreview?: JobServiceOptions["registerPreview"];
  previewProjects?: readonly PreviewRegistryProject[];
}

export interface RuntimeOptions {
  config: Config;
  db: GraphClient;
  lifecycle?: Lifecycle;
  instanceId?: string;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Trusted server adapters only; never populated from request arguments. */
  integrations?: RuntimeIntegrations;
  /** Credential source used only for explicitly named runner-only references. */
  environment?: NodeJS.ProcessEnv;
}

/** Compose real services without opening a listener or taking ownership of the caller's DB. */
export async function createRuntime(options: RuntimeOptions) {
  const { config, db } = options;
  const environment = options.environment ?? process.env;
  const hosted = config.runtimeMode === "hosted";
  const multiuser = config.auth.mode === "supabase";
  if ((hosted || multiuser) && (config.runner.configPath || config.registry.fixtureRegistryPath || options.integrations?.runner || options.integrations?.manager ||
      options.integrations?.repositories?.length || options.integrations?.runnerConfigs?.length || options.integrations?.experimentConfigs?.length)) {
    throw new Error("Hosted gateways cannot run local jobs, experiments, deployment managers or fixture seeding");
  }
  const lifecycle = options.lifecycle ?? new Lifecycle();
  const instanceId = options.instanceId ?? randomUUID();
  const report = await bootstrapSchema(db, RUNTIME_INDEX_SPECS);
  const readiness = configReadiness(config);
  const replace = (item: ReadinessItem) => {
    const index = readiness.findIndex((current) => current.name === item.name);
    if (index < 0) readiness.push(item); else readiness[index] = item;
  };
  const evidence = createEvidenceService(db);
  const integrations = options.integrations ?? {};
  let repositories = integrations.repositories ?? [];
  let runnerConfigs = integrations.runnerConfigs ?? [];
  let experimentConfigs = integrations.experimentConfigs ?? [];
  let runner = integrations.runner;
  let manager = integrations.manager;
  let resolveAuth = integrations.resolveAuth;
  let credentialStore: CredentialStore | undefined;
  try {
  let previewProjects = integrations.previewProjects ?? [];
  if (config.credentials.activeKeyVersion) {
    credentialStore = createConfiguredCredentialStore({ kind: "postgres", activeKeyVersion: config.credentials.activeKeyVersion, tls: true }, environment, multiuser);
    resolveAuth ??= createCredentialMediator({ db, store: credentialStore, timeoutMs: integrations.timeoutMs }).resolveAuth;
  }
  if (config.runner.configPath) {
    const file = RuntimeFile.parse(JSON.parse(await readFile(config.runner.configPath, "utf8")));
    repositories = integrations.repositories ?? file.repositories;
    runnerConfigs = integrations.runnerConfigs ?? file.runnerConfigs.map(({ environmentRefs, ...entry }) => ({ ...entry,
      environment: Object.fromEntries(Object.entries(environmentRefs).map(([name, reference]) => {
        if (/(?:OWNER|MANAGER|MANAGEMENT|VERCEL|FLYWHEEL|TOOLTUNER|FALKORDB|PRODUCTION|DEPLOY|BYPASS|PROJECT|ORG_ID|AWS|GITHUB|GH_TOKEN|UPSTREAM|OAUTH|CREDENTIAL)/i.test(reference)) {
          throw new Error("Runner environment references may name only independently provisioned runner credentials");
        }
        const value = environment[reference];
        if (!value) throw new Error(`Runner-only credential reference ${reference} is unset`);
        return [name, value];
      })) }));
    experimentConfigs = integrations.experimentConfigs ?? file.experimentConfigs;
    previewProjects = integrations.previewProjects ?? file.previewProjects.map((project) => ({
      owner_id: project.ownerId, application: project.application, repo_id: project.repoId,
      project_id: project.projectId, team_id: project.teamId,
    }));
    if (!runner && file.workspaceRoot && runnerConfigs.length) runner = createLocalRunner({ workspaceRoot: file.workspaceRoot });
    if (file.credentialStore) {
      if (credentialStore) throw new Error("Choose either environment-configured custody or credentialStore in RUNNER_CONFIG_PATH");
      credentialStore = createConfiguredCredentialStore(file.credentialStore, environment);
      const credentials = createCredentialMediator({ db, store: credentialStore, timeoutMs: integrations.timeoutMs });
      resolveAuth ??= credentials.resolveAuth;
      if (!manager && file.credentialStore.kind === "helper" && file.vercelExecutable && environment.VERCEL_TOKEN && file.previewProjects.length) {
        for (const project of file.previewProjects) {
          if ((config.vercel.projectId && config.vercel.projectId !== project.projectId) ||
              (config.vercel.teamId && config.vercel.teamId !== project.teamId)) throw new Error("Preview project mapping differs from the configured existing Vercel project/team");
        }
        const verifier = createProtectedPreviewVerifier({ credentials, projects: file.previewProjects, timeoutMs: integrations.timeoutMs });
        manager = createVercelManager({ executable: file.vercelExecutable, token: environment.VERCEL_TOKEN,
          projects: file.previewProjects, verifyRuntime: (target) => verifier.verifyRuntime(target) });
      }
    }
  }
  const privilegedValues = new Set([config.owner.secret, config.database.password, environment.VERCEL_TOKEN, environment.TOOLTUNER_CREDENTIAL_POSTGRES_URL, environment.TOOLTUNER_CREDENTIAL_KEYS, environment.FLYWHEEL_CREDENTIAL_POSTGRES_URL, environment.FLYWHEEL_CREDENTIAL_KEYS].filter((value): value is string => Boolean(value)));
  for (const value of Object.values(environment)) {
    if (!value?.startsWith("{")) continue;
    try {
      const credential = OAuthCredential.safeParse(JSON.parse(value));
      if (credential.success) for (const secret of [credential.data.tokens.access_token, credential.data.tokens.refresh_token, credential.data.client.client_secret]) {
        if (secret) privilegedValues.add(secret);
      }
    } catch { /* Unrelated environment values are not credential documents. */ }
  }
  for (const runnerConfig of runnerConfigs) {
    if (Object.values(runnerConfig.environment).some((value) => privilegedValues.has(value))) {
      throw new Error("A coding subprocess cannot reuse owner, database or deployment credentials");
    }
  }
  const recorder: CallRecorder = {
    findIdempotent: (...args) => evidence.recorder.findIdempotent(...args),
    async admit(admission) {
      if (!lifecycle.admissionOpen) throw new FlywheelError("operation_unavailable", "The server is shutting down; no new calls are admitted.");
      const admitted = await evidence.recorder.admit(admission);
      if (!lifecycle.admissionOpen) throw new FlywheelError("operation_unavailable", "Admission closed during persistence; this call was not executed.");
      lifecycle.begin(admitted.call_id);
      return admitted;
    },
    async complete(callId, completion) {
      await evidence.recorder.complete(callId, completion);
      lifecycle.end(callId);
    },
  };
  let core: GatewayCore;
  const registerPreview = integrations.registerPreview ?? createPreviewRegistry({ db, projects: previewProjects }).registerPreview;
  const previewConfigured = Boolean(manager && resolveAuth && (integrations.registerPreview || previewProjects.length));
  const jobs = createJobService({ db, repositories, runnerConfigs, runner, getPacket,
    manager: previewConfigured ? manager : undefined, registerPreview,
    issueDevelopmentToken: config.oauth.resource && !multiuser ? async (grant) => {
      if (grant.groups.length !== 1 || grant.groups[0] !== "development" || !grant.scope.job_id || !grant.scope.packet_id || grant.owner_id !== config.owner.id) {
        throw new FlywheelError("forbidden", "The coding credential must be development-only and bound to this owner, job and packet.");
      }
      const token = randomBytes(32).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const issued = await issueTokenPair(db, token, randomBytes(32).toString("base64url"), {
        client_id: `coding:${grant.scope.job_id}`, family_id: randomUUID(), grant_id: grant.grant_id,
        resource: config.oauth.resource!, scopes: ["flywheel"],
      }, grant.owner_id, now, now + 3600, now); // No usable refresh capability is given to a coding process.
      if (!issued) throw new FlywheelError("storage_unavailable", "Scoped development credential could not be issued.");
      return token;
    } : undefined,
  });
  const experiments = createExperimentService({ db, configs: experimentConfigs, getPacket, getCall, getEvidence,
    getVersion: (owner, application, id) => getVersion(db, owner, application, id),
    replay: createTrustedExperimentReplay({ db, recorder,
      getVersion: (owner, application, id) => getVersion(db, owner, application, id),
      invokePinned: (version, tool, args) => callUpstream(version, tool, args, { resolveAuth, timeoutMs: integrations.timeoutMs }),
    }),
  });
  const handlers = { ...evidence.handlers, get_job: jobs.get_job,
    get_experiment: experiments.get_experiment, recommend_candidate: experiments.recommend_candidate,
    ...(runner && runnerConfigs.length && repositories.length && config.oauth.resource ? { start_job: jobs.start_job } : {}),
    ...(previewConfigured && runner ? { register_preview: jobs.register_preview } : {}),
    ...(experimentConfigs.length ? { run_experiment: experiments.run_experiment } : {}),
  };
  core = createGatewayCore({ db, recorder, handlers, resolveAuth, timeoutMs: integrations.timeoutMs });
  replace({ name: "upstream_linking", status: resolveAuth ? "unverified" : "not_configured", critical: false,
    detail: resolveAuth ? "External credential mediation loaded; exact target binding and live introspection are required on use" : "No credential store/resolver configured; owner link commands are available and local fixtures need no account",
    action: "Run npm run owner -- account link --input <nonsecret-link.json> --subject <owner> --mode browser with a credential helper, or use --mode existing" });
  replace({ name: "runner", status: runner && runnerConfigs.length && repositories.length ? "unverified" : "not_configured", critical: false,
    detail: runner && runnerConfigs.length && repositories.length ? "Trusted runner adapter and allowlists loaded; sandbox/CLI start requires a real job receipt" : "No runnable adapter/repository configuration; start_job is unavailable",
    action: "Configure RUNNER_CONFIG_PATH and independently authenticated coding CLI; verify host bubblewrap namespaces" });
  replace({ name: "vercel", status: previewConfigured ? "unverified" : "not_configured", critical: false,
    detail: previewConfigured ? "Trusted preview and credential adapters injected; a verified provider receipt is still required" : "Trusted manager/protected-runtime/credential adapters are unavailable; no deployment will run",
    action: "Configure credentialStore, vercelExecutable and previewProjects in RUNNER_CONFIG_PATH with a manager-only VERCEL_TOKEN; only an existing project preview is allowed" });
  replace({ name: "experiments", status: experimentConfigs.length ? "unverified" : "not_configured", critical: false,
    detail: experimentConfigs.length ? "Immutable comparison configs loaded; actual arms run through the durable gateway with exact version pins" : "No comparison config; run_experiment is unavailable" });
  if (config.registry.fixtureRegistryPath) {
    const fixture = FixtureConfig.parse(JSON.parse(await readFile(config.registry.fixtureRegistryPath, "utf8")));
    const seeded = await seedConfiguredFixtures(db, { ...fixture, owner_id: config.owner.id });
    replace({ name: "fixtures", status: "ready", critical: false,
      detail: `Live catalogs verified; ${seeded.versions.length} immutable local fixture versions registered` });
  }
  const mounts: ((app: Express) => void)[] = [];
  let provider: FlywheelOAuthProvider | undefined;
  if (config.publicOrigin && config.oauth.resource && (multiuser || config.owner.secret)) {
    provider = new FlywheelOAuthProvider({ db, ownerId: config.owner.id, resource: config.oauth.resource, ownerSecret: config.owner.secret, multiuser });
    const gatewayOptions = { core, provider, ...(multiuser ? { humanAuth: createSupabaseAuth(config.auth.supabase!) } : {}), publicOrigin: config.publicOrigin, resource: config.oauth.resource, log: options.log,
      ...(hosted ? { trustProxy: false, rateLimitStore: (endpoint: string) => createGraphRateLimitStore(db, endpoint) } : {}) };
    mounts.push((app) => mountGateway(app, gatewayOptions));
    replace({ name: "flywheel_oauth", status: "unverified", critical: true,
      detail: "OAuth discovery, DCR, PKCE, refresh, consent and protected /mcp mounted; real client consent remains unverified",
      action: `Create separate owner grants and connect clients to ${config.oauth.resource}` });
  }
  if (hosted) {
    replace({ name: "runtime", status: "ready", critical: false, detail: "Hosted request handler; local listeners, fixtures, runners and deployment managers are disabled" });
    replace({ name: "runner", status: "not_configured", critical: false, detail: "Local coding jobs are disabled in hosted mode" });
    replace({ name: "vercel", status: "not_configured", critical: false, detail: "Deployment management is disabled in the hosted gateway" });
  }
  const app = createApp({ instanceId, lifecycle,
    checkStorage: async () => ({ graph: db.graphName, schema_version: await readSchemaVersion(db) }), mounts });
  return { app, core, provider, lifecycle, instanceId, readiness, report, handlers, closeCredentials: async () => { await credentialStore?.close?.(); } };
  } catch (error) {
    await credentialStore?.close?.();
    throw error;
  }
}

function listen(server: Server, config: Config): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(new Error(`Port ${config.http.port} on ${config.http.host} is already in use. Stop the other process or set PORT to a free port.`));
      else reject(error);
    };
    server.once("error", fail);
    server.listen(config.http.port, config.http.host, () => { server.off("error", fail); resolve(); });
  });
}

/** Own the DB and HTTP listener, including cleanup after partial startup failure. */
export async function startRuntime(config: Config, options: Omit<RuntimeOptions, "config" | "db"> = {}) {
  const db = await GraphClient.connect(config.database);
  try {
    const runtime = await createRuntime({ config, db, ...options });
    const server = createServer(runtime.app);
    await listen(server, config);
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      runtime.lifecycle.closeAdmission();
      try { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
      finally { try { await runtime.closeCredentials(); } finally { await db.close(); } }
    })();
    return { ...runtime, db, server, close };
  } catch (error) { await db.close(); throw error; }
}
