/** Verify persisted state and production service restart inside the disposable demo graph. */
import { resolveToolTunerEnvironment } from "../src/config.js";
import assert from "node:assert/strict";
import { GraphClient } from "../src/db/client.js";
import { getCall, getPacket, getRecord } from "../src/db/evidence.js";
import { getStable } from "../src/db/registry.js";

const input = JSON.parse(process.argv[2]!) as {
  graph: string; call: string; packet: string; digest: string; stable: string; evaluation: string;
  activation: string; rollback: string;
};
const db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph: input.graph,
  username: process.env.FALKORDB_USERNAME, password: process.env.FALKORDB_PASSWORD });
try {
  assert.equal((await getCall(db, "owner", input.call))?.outcome, "success");
  assert.equal((await getPacket(db, "owner", input.packet))?.digest, input.digest);
  assert.equal((await getStable(db, "owner", "textkit"))?.version_id, input.stable);
  assert.equal((await getRecord(db, "owner", input.evaluation))?.record.state, "completed");
  assert.equal((await getRecord(db, "owner", input.activation))?.record.kind, "activate");
  assert.equal((await getRecord(db, "owner", input.rollback))?.record.kind, "rollback");
} finally { await db.close(); }

// The parent closed its listener. Start the actual service entrypoint twice on that same origin.
const { spawn } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const environment = resolveToolTunerEnvironment(process.env);
const origin = environment.TOOLTUNER_PUBLIC_ORIGIN!;
let stopActiveServer: (() => Promise<void>) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void (stopActiveServer?.() ?? Promise.resolve()).finally(() => process.exit(1));
  });
}
for (let generation = 1; generation <= 2; generation++) {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: new URL(origin).port,
      TOOLTUNER_PUBLIC_ORIGIN: origin, TOOLTUNER_OWNER_SECRET: environment.TOOLTUNER_OWNER_SECRET,
      FALKORDB_GRAPH: input.graph, FALKORDB_URL: process.env.FALKORDB_URL,
      ...(process.env.FALKORDB_USERNAME ? { FALKORDB_USERNAME: process.env.FALKORDB_USERNAME } : {}),
      ...(process.env.FALKORDB_PASSWORD ? { FALKORDB_PASSWORD: process.env.FALKORDB_PASSWORD } : {}) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  // Do not print service logs or the environment: test authentication values stay private.
  child.stderr.resume();
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve([code, signal]));
  });
  const stopServer = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  stopActiveServer = stopServer;
  const clients: InstanceType<typeof Client>[] = [];
  try {
    const deadline = Date.now() + 8_000;
    let healthy = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { healthy = (await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(250) })).status === 200; }
      catch { /* Wait for this owned server to bootstrap. */ }
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(healthy, `Service generation ${generation} must become healthy`);
    for (const [name, token] of [["user", process.env.DEMO_ACCESS_TOKEN], ["development", process.env.DEMO_DEVELOPMENT_TOKEN]]) {
      const client = new Client({ name: `restart-${name}`, version: "1.0.0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const args = name === "user"
        ? { application: "textkit", tool: "word_count", args: { text: "alpha  beta\ngamma" } }
        : { application: "flywheel", tool: "get_evidence", args: { refs: [input.call, input.packet] } };
      const result = (await client.callTool({ name: "dispatch", arguments: args })).structuredContent as Record<string, unknown>;
      assert.equal(result.outcome, "success");
      if (name === "user") assert.equal(result.resolved_version, input.stable);
      else {
        const evidence = result.result as { items: { ref: string }[]; missing_refs: string[] };
        assert.deepEqual(evidence.items.map((item) => item.ref).sort(), [input.call, input.packet].sort());
        assert.deepEqual(evidence.missing_refs, []);
      }
    }
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopServer();
    stopActiveServer = undefined;
    const [code, signal] = await exited;
    assert.equal(code, 0); assert.equal(signal, null);
  }
}
process.stdout.write(JSON.stringify({ separate_process_readback: "passed", production_service_restart: "passed" }));
