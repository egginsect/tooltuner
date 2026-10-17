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
import { Grant, GrantId, newId, SCHEMA_VERSION, ToolGroup, type Grant as GrantRecord } from "../contracts.js";
import { loadConfig } from "../config.js";
import { GraphClient } from "../db/client.js";
import { bootstrapSchema, INDEX_SPECS } from "../db/schema.js";
import { insertGrant, listGrants, revokeGrant } from "../db/auth.js";

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

/** Owner grant commands; later layers add account and version decisions. */
export const COMMANDS: Record<string, Command> = {
  "grant create": grantCreate,
  "grant list": grantList,
  "grant revoke": grantRevoke,
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
    await bootstrapSchema(db, INDEX_SPECS);
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
