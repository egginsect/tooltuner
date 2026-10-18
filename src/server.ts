/**
 * Process entrypoint: `npm start`. Boot order is config -> FalkorDB -> schema bootstrap ->
 * HTTP listener -> readiness report. Any critical failure exits non-zero with an actionable
 * message; there is no in-memory fallback.
 */
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { createApp, SERVICE_NAME } from "./app.js";
import { ConfigError, describeConfig, loadConfig, type Config } from "./config.js";
import { GraphClient } from "./db/client.js";
import { INDEX_SPECS, bootstrapSchema, readSchemaVersion } from "./db/schema.js";
import { Lifecycle } from "./lifecycle.js";
import { createLogger, type Logger } from "./log.js";
import { configReadiness, formatReadiness, type ReadinessItem } from "./readiness.js";

function listen(server: Server, config: Config): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Port ${config.http.port} on ${config.http.host} is already in use. Stop the other process or set PORT to a free port.`));
      } else if (error.code === "EACCES") {
        reject(new Error(`No permission to bind ${config.http.host}:${config.http.port}. Choose a port above 1024 via PORT.`));
      } else {
        reject(error);
      }
    });
    server.listen(config.http.port, config.http.host, () => resolve());
  });
}

/** Prove the fixed public origin reaches THIS process by fetching its /healthz and matching the instance ID. */
async function verifyPublicOrigin(origin: string, instanceId: string): Promise<ReadinessItem> {
  try {
    const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000), headers: { "ngrok-skip-browser-warning": "1" } });
    const body = (await response.json()) as { instance_id?: string };
    if (response.ok && body.instance_id === instanceId) {
      return { name: "public_origin", status: "ready", critical: false, detail: `${origin} reaches this process (instance ${instanceId.slice(0, 8)})` };
    }
    return {
      name: "public_origin",
      status: "failed",
      critical: false,
      detail: `${origin}/healthz answered HTTP ${response.status} but did not identify this process`,
      action: "Check that the tunnel forwards to this host and port and that FLYWHEEL_PUBLIC_ORIGIN matches the tunnel hostname",
    };
  } catch (error) {
    return {
      name: "public_origin",
      status: "failed",
      critical: false,
      detail: `${origin} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
      action: "Start the tunnel (for example `ngrok http --url=<your-dev-domain> <port>`) and restart this server",
    };
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\nSee .env.example for the supported variables.\n`);
      process.exit(1);
    }
    throw error;
  }
  const log: Logger = createLogger(config.logLevel);
  log.info(`${SERVICE_NAME} starting`, { config: describeConfig(config) });

  const items: ReadinessItem[] = [];
  let db: GraphClient;
  try {
    db = await GraphClient.connect({ url: config.database.url, graph: config.database.graph, username: config.database.username, password: config.database.password });
    items.push({ name: "falkordb", status: "ready", critical: true, detail: `Connected to ${config.database.url}, graph "${config.database.graph}"` });
    const report = await bootstrapSchema(db, INDEX_SPECS);
    items.push({
      name: "schema_bootstrap",
      status: "ready",
      critical: true,
      detail: `schema_version ${report.schemaVersion}; ${report.indexesCreated} indexes and ${report.constraintsCreated} constraints created${report.freshGraph ? " (fresh graph)" : " (existing data kept)"}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Startup failed: ${message}`);
    process.exit(1);
  }

  const instanceId = randomUUID();
  const lifecycle = new Lifecycle();
  // SEAM: the gateway worker adds its mount here (routes for /mcp, OAuth and discovery), for example
  // `mounts: [(app) => gateway.mount(app)]`, passing `config`, `db` and `lifecycle` explicitly.
  const app = createApp({
    instanceId,
    lifecycle,
    checkStorage: async () => ({ graph: db.graphName, schema_version: await readSchemaVersion(db) }),
    mounts: [],
  });
  const server = createServer(app);
  try {
    await listen(server, config);
  } catch (error) {
    log.error(`Startup failed: ${error instanceof Error ? error.message : String(error)}`);
    await db.close();
    process.exit(1);
  }
  items.push({ name: "http_bind", status: "ready", critical: true, detail: `Listening on http://${config.http.host}:${config.http.port} (GET /healthz)` });

  const configItems = configReadiness(config);
  for (const item of configItems) {
    items.push(item.name === "public_origin" && config.publicOrigin !== undefined ? await verifyPublicOrigin(config.publicOrigin, instanceId) : item);
  }
  for (const line of formatReadiness(items)) log.info(line);
  log.info("Ready: local health endpoint is up. Features marked unverified or not_configured are not available yet.");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycle.closeAdmission();
    const pending = lifecycle.pending();
    log.warn(`Received ${signal}: admission closed`, { calls_without_completion: pending.length, call_ids: pending });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    log.info("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
