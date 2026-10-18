/** Process entrypoint; all services are composed in runtime.ts. */
import { pathToFileURL } from "node:url";
import { ConfigError, describeConfig, loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { formatReadiness, type ReadinessItem } from "./readiness.js";
import { startRuntime } from "./runtime.js";

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
      action: "Check that the tunnel forwards to this host and port and that TOOLTUNER_PUBLIC_ORIGIN matches the tunnel hostname",
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


export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log = createLogger(config.logLevel);
  log.info("tooltuner starting", { config: describeConfig(config) });
  const runtime = await startRuntime(config, { log: (message, fields) => log.info(message, fields) });
  // Install signal handlers before a public-origin probe can delay startup.
  const shutdown = (signal: string) => {
    runtime.lifecycle.closeAdmission();
    log.warn(`Received ${signal}: admission closed`, { calls_without_completion: runtime.lifecycle.pending() });
    void runtime.close().then(() => log.info("Shutdown complete")).catch(() => {
      log.error("Shutdown failed while closing HTTP or storage");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  const items: ReadinessItem[] = [
    { name: "falkordb", status: "ready", critical: true, detail: `Connected; graph "${runtime.db.graphName}"` },
    { name: "schema_bootstrap", status: "ready", critical: true,
      detail: `schema_version ${runtime.report.schemaVersion}; ${runtime.report.indexesCreated} indexes and ${runtime.report.constraintsCreated} constraints created` },
    { name: "http_bind", status: "ready", critical: true, detail: `Listening on http://${config.http.host}:${config.http.port}` },
  ];
  for (const item of runtime.readiness) {
    items.push(item.name === "public_origin" && config.publicOrigin !== undefined
      ? await verifyPublicOrigin(config.publicOrigin, runtime.instanceId) : item);
  }
  for (const line of formatReadiness(items)) log.info(line);
  if (runtime.provider) log.info("OAuth/MCP routes mounted", { mcp: config.oauth.resource, consent: `${config.publicOrigin}/oauth/consent` });
  log.info("Local service started; read each readiness item before using optional integrations.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof ConfigError ? error.message : `Startup failed: ${error instanceof Error ? error.message : String(error)}`}\n`);
    process.exitCode = 1;
  });
}
