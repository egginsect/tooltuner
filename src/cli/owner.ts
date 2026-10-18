/**
 * Owner CLI: the operator control channel. Runs locally against FalkorDB and is
 * the only place grants are created and human decisions are recorded; no MCP
 * grant can reach these commands.
 *
 *   npm run owner -- grant create --label claude-user --groups user --apps textkit,catalog
 *   npm run owner -- grant create --label coder --groups development --apps textkit --packet pkt_...
 *   npm run owner -- grant list
 *   npm run owner -- grant revoke grant_...
 */
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Grant, GrantId, newId, SCHEMA_VERSION, ToolGroup, type Grant as GrantRecord } from "../contracts.js";
import { createPostgresCredentialStore } from "../gateway/postgres-credentials.js";
import { credentialPostgresSecrets, loadConfig } from "../config.js";
import { GraphClient } from "../db/client.js";
import { bootstrapSchema, INDEX_SPECS } from "../db/schema.js";
import { insertGrant, listGrants, revokeGrant } from "../db/auth.js";
import { REGISTRY_INDEX_SPECS, UpstreamAccount, CredentialBinding } from "../db/registry.js";
import { activateVersion, rollbackVersion, recordMerge } from "./versions.js";
import { HumanDecision } from "../contracts.js";
import { beginUpstreamAccountLink, linkUpstreamAccount } from "./link.js";
import { CredentialStoreConfiguration, createConfiguredCredentialStore } from "../runtime.js";
import { enrollLocalApplication } from "./enroll.js";

type Command = (db: GraphClient, ownerId: string, argv: string[]) => Promise<unknown>;

const list = (v: string | undefined): string[] => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** `--tools textkit:word_count+char_count,flywheel:report_feedback` */
function parseTools(v: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const entry of list(v)) {
    const [app, tools, extra] = entry.split(":");
    if (!app || !tools || extra !== undefined) throw new Error(`--tools entry "${entry}" must look like app:tool1+tool2`);
    out[app] = tools.split("+").filter(Boolean);
  }
  return out;
}

const grantCreate: Command = async (db, ownerId, argv) => {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: "string" },
      groups: { type: "string" },
      apps: { type: "string" },
      tools: { type: "string" },
      repos: { type: "string" },
      job: { type: "string" },
      packet: { type: "string" },
    },
  });
  if (!values.label || !values.groups || !values.apps) {
    throw new Error("grant create needs --label, --groups (user,development,management) and --apps (names or *)");
  }
  const grant: GrantRecord = Grant.parse({
    schema_version: SCHEMA_VERSION,
    grant_id: newId("grant"),
    owner_id: ownerId,
    label: values.label,
    groups: list(values.groups).map((g) => ToolGroup.parse(g)),
    allow: { apps: list(values.apps), tools: parseTools(values.tools), repos: list(values.repos) },
    scope: { ...(values.job ? { job_id: values.job } : {}), ...(values.packet ? { packet_id: values.packet } : {}) },
    created_at: new Date().toISOString(),
    revoked_at: null,
  });
  await insertGrant(db, grant);
  return grant;
};

const grantList: Command = async (db, ownerId) =>
  (await listGrants(db, ownerId)).map((g) => ({
    grant_id: g.grant_id,
    label: g.label,
    groups: g.groups,
    apps: g.allow.apps,
    tools: g.allow.tools,
    repos: g.allow.repos,
    scope: g.scope,
    revoked_at: g.revoked_at,
  }));

const grantRevoke: Command = async (db, ownerId, argv) => {
  if (argv.length !== 1) throw new Error("grant revoke needs exactly one grant id");
  const id = GrantId.parse(argv[0]);
  const ok = await revokeGrant(db, id, new Date().toISOString(), ownerId);
  if (!ok) throw new Error(`Grant ${id} was not found`);
  return { grant_id: id, revoked: true, note: "All tokens issued under this grant are revoked." };
};

/** These record owner decisions only; merge does not execute a Git merge. */
function ownerDecision(kind: "merge" | "activate" | "rollback"): Command {
  return async (db, ownerId, argv) => {
    const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, subject: { type: "string" } } });
    if (!values.input || !values.subject) throw new Error(`decision ${kind} needs --input <receipt.json> and --subject <owner identity>`);
    const schema = HumanDecision.omit({ schema_version: true, owner_id: true, created_at: true, provenance: true,
      completeness: true, decision_id: true, kind: true }).extend({ receipt: z.record(z.string(), z.unknown()) }).strict();
    const input = schema.parse(JSON.parse(await readFile(values.input, "utf8")));
    const owner = { owner_id: ownerId, subject: values.subject };
    if (kind === "merge") {
      if (!input.source) throw new Error("A merge decision needs the actual merged source and receipt");
      return recordMerge(db, owner, { ...input, source: input.source });
    }
    if (!input.selected_version_id || input.source !== null) throw new Error("Activation/rollback need an exact selected version and source:null");
    return (kind === "activate" ? activateVersion : rollbackVersion)(db, owner, { ...input, selected_version_id: input.selected_version_id });
  };
}

const accountLink: Command = async (db, ownerId, argv) => {
  const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, subject: { type: "string" }, mode: { type: "string", default: "browser" } } });
  if (!values.input || !values.subject || !["browser", "existing"].includes(values.mode!)) {
    throw new Error("account link needs --input <nonsecret-link.json> --subject <owner identity> and --mode browser|existing");
  }
  const schema = z.object({
    credentialStore: CredentialStoreConfiguration,
    account: UpstreamAccount.omit({ schema_version: true, owner_id: true, created_at: true, client_id: true }).extend({ client_id: z.string().min(1).optional() }).strict(),
    target: CredentialBinding.omit({ schema_version: true, owner_id: true, created_at: true, auth_config_ref: true,
      application: true, repo_id: true, environment: true, issuer: true, scopes: true }).strict(),
  }).strict();
  const input = schema.parse(JSON.parse(await readFile(values.input, "utf8")));
  const options = { db, owner: { owner_id: ownerId, subject: values.subject }, store: createConfiguredCredentialStore(input.credentialStore, process.env),
    account: input.account, target: input.target };
  try {
    const result = values.mode === "existing" ? await linkUpstreamAccount(options) : await beginUpstreamAccountLink({ ...options,
      onAuthorizationUrl: (url) => { process.stderr.write(`Open this owner authorization URL in your local browser: ${url.href}\n`); },
    });
    return { linked: true, auth_config_ref: result.account.auth_config_ref, application: result.account.application,
      repo_id: result.account.repo_id, environment: result.account.environment, resource: result.binding.resource, schema_digest: result.schema_digest };
  } finally { await options.store.close?.(); }
};

export const COMMANDS: Record<string, Command> = {
  "credential initialize": async (_db, _ownerId, argv) => {
    const { values } = parseArgs({ args: argv, options: { input: { type: "string" } } });
    if (!values.input) throw new Error("credential initialize needs --input <nonsecret-store.json>");
    const configuration = CredentialStoreConfiguration.parse(JSON.parse(await readFile(values.input, "utf8")));
    if (configuration.kind !== "postgres") throw new Error("credential initialize requires a PostgreSQL credential store configuration");
    const store = createPostgresCredentialStore({ ...configuration, ...credentialPostgresSecrets(process.env) });
    try { await store.initialize(); return { initialized: true }; } finally { await store.close(); }
  },
  "application enroll-local": async (db, ownerId, argv) => {
    const { values } = parseArgs({ args: argv, options: { input: { type: "string" }, subject: { type: "string" } } });
    if (!values.input || !values.subject) throw new Error("application enroll-local needs --input <nonsecret-local-app.json> --subject <owner identity>");
    return enrollLocalApplication(db, { owner_id: ownerId, subject: values.subject }, JSON.parse(await readFile(values.input, "utf8")));
  },
  "grant create": grantCreate,
  "grant list": grantList,
  "grant revoke": grantRevoke,
  "account link": accountLink,
  "decision merge": ownerDecision("merge"),
  "decision activate": ownerDecision("activate"),
  "decision rollback": ownerDecision("rollback"),
};

async function main(): Promise<void> {
  const [group = "", action = "", ...rest] = process.argv.slice(2);
  const command = COMMANDS[`${group} ${action}`];
  if (!command) {
    process.stderr.write(`Unknown command "${group} ${action}". Available: ${Object.keys(COMMANDS).join(", ")}\n`);
    process.exit(2);
  }
  const config = loadConfig(process.env);
  const db = await GraphClient.connect({
    url: config.database.url,
    graph: config.database.graph,
    username: config.database.username,
    password: config.database.password,
  });
  try {
    await bootstrapSchema(db, [...INDEX_SPECS, ...REGISTRY_INDEX_SPECS]);
    const result = await command(db, config.owner.id, rest);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`owner: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
