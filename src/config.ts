/**
 * Environment configuration, validated once at startup. Secrets are read here only where the
 * process itself needs them (database password); everything else reports presence only.
 * Empty strings count as unset, so `.env.example` can list every key.
 */
import { z } from "zod";

const emptyToUndefined = (value: unknown): unknown => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(emptyToUndefined, schema.optional());

/** Public origin: scheme + host (+ port) only. HTTPS is required except for localhost development. */
const originSchema = z.url().superRefine((value, ctx) => {
  const url = new URL(value);
  if (url.origin !== value) ctx.addIssue({ code: "custom", message: `Must be an origin without path or trailing slash, for example ${url.origin}` });
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) ctx.addIssue({ code: "custom", message: "Must use https unless the host is localhost" });
});

const EnvSchema = z.object({
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(65_535).default(8787)),
  HOST: z.preprocess(emptyToUndefined, z.string().min(1).default("127.0.0.1")),
  FALKORDB_URL: z.preprocess(emptyToUndefined, z.string().regex(/^(redis|rediss|falkor|falkors):\/\/[^/@\s]+(:\d+)?\/?$/, "Must look like redis://host:port without credentials").default("redis://127.0.0.1:6379")),
  FALKORDB_GRAPH: z.preprocess(emptyToUndefined, z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "Graph names are 1-64 characters of [A-Za-z0-9_-] starting with a letter").default("flywheel")),
  FALKORDB_USERNAME: optional(z.string()),
  FALKORDB_PASSWORD: optional(z.string()),
  FLYWHEEL_PUBLIC_ORIGIN: optional(originSchema),
  OAUTH_ISSUER: optional(z.url()),
  OAUTH_RESOURCE: optional(z.url()),
  FLYWHEEL_OWNER_ID: z.preprocess(emptyToUndefined, z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).default("owner")),
  FLYWHEEL_OWNER_SECRET: optional(z.string().min(16, "Use at least 16 characters")),
  FIXTURE_REGISTRY_PATH: optional(z.string()),
  RUNNER_CONFIG_PATH: optional(z.string()),
  VERCEL_PROJECT_ID: optional(z.string()),
  VERCEL_TEAM_ID: optional(z.string()),
  VERCEL_TOKEN: optional(z.string()),
  FLYWHEEL_CREDENTIAL_POSTGRES_URL: optional(z.string().min(1)),
  FLYWHEEL_CREDENTIAL_KEYS: optional(z.string().min(1)),
  LOG_LEVEL: z.preprocess(emptyToUndefined, z.enum(["debug", "info", "warn", "error"]).default("info")),
});

export interface Config {
  http: { host: string; port: number };
  database: { url: string; graph: string; username: string | undefined; password: string | undefined };
  /** Fixed public HTTPS origin served by the tunnel; undefined until configured. */
  publicOrigin: string | undefined;
  owner: { id: string; secret: string | undefined };
  oauth: {
    issuer: string | undefined;
    /** Protected resource URL; defaults to `<publicOrigin>/mcp` when only the origin is set. */
    resource: string | undefined;
  };
  registry: { fixtureRegistryPath: string | undefined };
  runner: { configPath: string | undefined };
  vercel: { projectId: string | undefined; teamId: string | undefined; tokenPresent: boolean };
  logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

/** Parse and cross-check the environment. Throws ConfigError listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`));
  }
  const values = parsed.data;
  const problems: string[] = [];

  const publicOrigin = values.FLYWHEEL_PUBLIC_ORIGIN;
  const resource = values.OAUTH_RESOURCE ?? (publicOrigin === undefined ? undefined : `${publicOrigin}/mcp`);
  if (values.OAUTH_RESOURCE !== undefined && publicOrigin === undefined) {
    problems.push("OAUTH_RESOURCE: set FLYWHEEL_PUBLIC_ORIGIN so the resource endpoint can be checked");
  }
  if (publicOrigin !== undefined && resource !== `${publicOrigin}/mcp`) {
    problems.push("OAUTH_RESOURCE: must equal FLYWHEEL_PUBLIC_ORIGIN followed by /mcp");
  }
  const issuer = publicOrigin === undefined ? undefined : new URL(publicOrigin).href;
  if (values.OAUTH_ISSUER !== undefined && (issuer === undefined || new URL(values.OAUTH_ISSUER).href !== issuer)) {
    problems.push("OAUTH_ISSUER: must equal FLYWHEEL_PUBLIC_ORIGIN; the built-in authorization server uses that origin");
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    http: { host: values.HOST, port: values.PORT },
    database: { url: values.FALKORDB_URL, graph: values.FALKORDB_GRAPH, username: values.FALKORDB_USERNAME, password: values.FALKORDB_PASSWORD },
    publicOrigin,
    owner: { id: values.FLYWHEEL_OWNER_ID, secret: values.FLYWHEEL_OWNER_SECRET },
    oauth: {
      issuer,
      resource,
    },
    registry: { fixtureRegistryPath: values.FIXTURE_REGISTRY_PATH },
    runner: { configPath: values.RUNNER_CONFIG_PATH },
    vercel: { projectId: values.VERCEL_PROJECT_ID, teamId: values.VERCEL_TEAM_ID, tokenPresent: values.VERCEL_TOKEN !== undefined },
    logLevel: values.LOG_LEVEL,
  };
}

/** Log-safe view: credentials appear only as presence flags. */
export function describeConfig(config: Config): Record<string, unknown> {
  return {
    http: config.http,
    database: {
      url: config.database.url,
      graph: config.database.graph,
      username: config.database.username === undefined ? "unset" : "set",
      password: config.database.password === undefined ? "unset" : "set",
    },
    publicOrigin: config.publicOrigin ?? "unset",
    owner: { id: config.owner.id, secret: config.owner.secret === undefined ? "unset" : "set" },
    oauth: {
      issuer: config.oauth.issuer ?? "unset",
      resource: config.oauth.resource ?? "unset",
    },
    registry: { fixtureRegistryPath: config.registry.fixtureRegistryPath ?? "unset" },
    runner: { configPath: config.runner.configPath ?? "unset" },
    vercel: { projectId: config.vercel.projectId ?? "unset", teamId: config.vercel.teamId ?? "unset", token: config.vercel.tokenPresent ? "set" : "unset" },
    logLevel: config.logLevel,
  };
}

/** Validated separately so key material never enters the public Config object or its errors. */
export function credentialPostgresSecrets(environment: NodeJS.ProcessEnv): { connectionString: string; keys: Record<string, Buffer> } {
  try {
    const connectionString = z.string().min(1).parse(environment.FLYWHEEL_CREDENTIAL_POSTGRES_URL);
    const input = z.record(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/), z.string().regex(/^[A-Za-z0-9+/]{43}=$/)).parse(JSON.parse(environment.FLYWHEEL_CREDENTIAL_KEYS ?? ""));
    const keys = Object.fromEntries(Object.entries(input).map(([version, value]) => [version, Buffer.from(value, "base64")]));
    if (!Object.keys(keys).length || Object.values(keys).some((key) => key.length !== 32)) throw new Error();
    return { connectionString, keys };
  } catch { throw new ConfigError(["Encrypted credential custody needs a PostgreSQL URL and a versioned JSON keyring of 32-byte base64 keys in its dedicated environment variables (values withheld)"]); }
}
