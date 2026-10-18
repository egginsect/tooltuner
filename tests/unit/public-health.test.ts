import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createApp, type StorageStatus } from "../../src/app.js";
import { Lifecycle } from "../../src/lifecycle.js";
import { StorageError } from "../../src/errors.js";

async function probe(checkStorage: () => Promise<StorageStatus>, failureRoute = false) {
  const app = createApp({ instanceId: "synthetic-instance", lifecycle: new Lifecycle(), checkStorage,
    mounts: failureRoute ? [(app) => { app.get("/synthetic-error", () => { throw new StorageError("storage_unavailable", "synthetic-private-diagnostic"); }); }] : [] });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${failureRoute ? "synthetic-error" : "healthz"}`);
    return { status: response.status, body: await response.json() as { checks?: { falkordb: unknown }; error?: { code: string; message: string } } };
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

it("public health reports readiness without the internal graph name", async () => {
  const result = await probe(async () => ({ graph: "synthetic-private-graph", schema_version: 1 }));
  expect(result.status).toBe(200);
  expect(result.body.checks?.falkordb).toEqual({ status: "ok", schema_version: 1 });
  expect(JSON.stringify(result.body)).not.toContain("synthetic-private-graph");
});

it("public health preserves failure classification without raw diagnostic text", async () => {
  const result = await probe(async () => { throw new StorageError("storage_unavailable", "synthetic-private-diagnostic", { outcomeCertainty: "not_executed" }); });
  expect(result.status).toBe(503);
  expect(result.body.error).toMatchObject({ code: "storage_unavailable", message: "Storage check failed", outcome_certainty: "not_executed" });
  expect(JSON.stringify(result.body)).not.toContain("synthetic-private-diagnostic");
});

it("the fallback HTTP error handler also suppresses raw storage diagnostics", async () => {
  const result = await probe(async () => ({ graph: "unused", schema_version: 1 }), true);
  expect(result.status).toBe(500);
  expect(result.body.error?.code).toBe("storage_unavailable");
  expect(JSON.stringify(result.body)).not.toContain("synthetic-private-diagnostic");
});
