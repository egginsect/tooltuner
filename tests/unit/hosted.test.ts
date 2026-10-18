import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostedHandler, startHostedRuntime, type HostedRuntime } from "../../src/hosted.js";
import { loadConfig } from "../../src/config.js";
import { GraphClient } from "../../src/db/client.js";
import { createRuntime } from "../../src/runtime.js";
import * as schema from "../../src/db/schema.js";
import { createGraphRateLimitStore } from "../../src/db/rate-limits.js";
import type { Options } from "express-rate-limit";

const hostedEnv = { FLYWHEEL_RUNTIME_MODE: "hosted", FALKORDB_URL: "rediss://graph.example:6379", FALKORDB_PASSWORD: "test-password",
  FLYWHEEL_PUBLIC_ORIGIN: "https://gateway.example", FLYWHEEL_OWNER_SECRET: "test-only-owner-consent-secret-32-characters" };

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function response() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, { headersSent: false, destroyed: false, statusCode: 200, body: "", headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    end(value: string) { this.body = value; this.headersSent = true; emitter.emit("finish"); },
  }) as unknown as ServerResponse & { body: string; headers: Record<string, string> };
}
const request = {} as IncomingMessage;
function fakeRuntime() {
  const app = vi.fn((_req: IncomingMessage, res: ServerResponse) => res.end("ok"));
  const close = vi.fn(async () => undefined);
  return { runtime: { app: app as unknown as Express, close } satisfies HostedRuntime, app, close };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("hosted configuration", () => {
  it("requires explicit authenticated external TLS storage, fixed origin and strong consent secret", () => {
    expect(() => loadConfig({ FLYWHEEL_RUNTIME_MODE: "hosted" })).toThrow(/external TLS endpoint/);
    const config = loadConfig(hostedEnv);
    expect(config.database).toMatchObject({ maxReconnectAttempts: 0, connectTimeoutMs: 3000, queryTimeoutMs: 5000 });
    expect(config.oauth.resource).toBe("https://gateway.example/mcp");
    for (const extra of [{ FALKORDB_URL: "redis://graph.example:6379" }, { FLYWHEEL_PUBLIC_ORIGIN: "http://localhost:8787" },
      { FALKORDB_PASSWORD: "" }, { FLYWHEEL_OWNER_SECRET: "a".repeat(20) }]) {
      expect(() => loadConfig({ ...hostedEnv, ...extra })).toThrow();
    }
  });
  it("rejects local paths and deployment-manager credentials before runtime creation", () => {
    for (const key of ["RUNNER_CONFIG_PATH", "FIXTURE_REGISTRY_PATH", "VERCEL_TOKEN"]) {
      expect(() => loadConfig({ ...hostedEnv, [key]: "test-only-forbidden" })).toThrow(key);
    }
  });
  it("supports transaction pooling without a mandatory mode declaration and bounds timeouts", () => {
    const credentials = { FLYWHEEL_CREDENTIAL_ACTIVE_KEY_VERSION: "v1", FLYWHEEL_CREDENTIAL_POSTGRES_URL: "test", FLYWHEEL_CREDENTIAL_KEYS: "test" };
    expect(loadConfig({ ...hostedEnv, ...credentials }).credentials.connectionMode).toBeUndefined();
    expect(loadConfig({ ...hostedEnv, ...credentials, FLYWHEEL_CREDENTIAL_POSTGRES_CONNECTION_MODE: "transaction" }).credentials.connectionMode).toBe("transaction");
    expect(loadConfig({ ...hostedEnv, ...credentials, FLYWHEEL_CREDENTIAL_POSTGRES_CONNECTION_MODE: "direct" }).credentials.connectionMode).toBe("direct");
    expect(() => loadConfig({ ...hostedEnv, FALKORDB_CONNECT_TIMEOUT_MS: "0" })).toThrow();
    expect(() => loadConfig({ ...hostedEnv, FALKORDB_QUERY_TIMEOUT_MS: "999999" })).toThrow();
  });
  it("guards hosted runtime composition even with injected adapters", async () => {
    const bootstrap = vi.spyOn(schema, "bootstrapSchema");
    await expect(createRuntime({ config: loadConfig(hostedEnv), db: {} as GraphClient,
      integrations: { repositories: [{ repoId: "test" } as never] } })).rejects.toThrow(/cannot run local jobs/);
    expect(bootstrap).not.toHaveBeenCalled();
  });
  it("closes a partially started database when composition fails", async () => {
    const close = vi.fn(async () => undefined);
    vi.spyOn(GraphClient, "connect").mockResolvedValue({ close } as unknown as GraphClient);
    vi.spyOn(schema, "bootstrapSchema").mockRejectedValue(new Error("test configuration failure"));
    await expect(startHostedRuntime(hostedEnv)).rejects.toThrow("test configuration failure");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("hosted request handler", () => {
  it("initializes lazily once for concurrent and warm requests without a listener", async () => {
    const pending = deferred<HostedRuntime>();
    const initialize = vi.fn(() => pending.promise);
    const handler = createHostedHandler({ initialize });
    expect(initialize).not.toHaveBeenCalled();
    const first = response(); const second = response();
    const a = handler(request, first); const b = handler(request, second);
    const runtime = fakeRuntime();
    pending.resolve(runtime.runtime);
    await Promise.all([a, b]);
    await handler(request, response());
    expect(initialize).toHaveBeenCalledOnce();
    expect(runtime.app).toHaveBeenCalledTimes(3);
    expect(first.body).toBe("ok");
    expect(runtime.close).not.toHaveBeenCalled();
  });
  it("returns sanitized 503 and retries initialization after an ordinary failure", async () => {
    const runtime = fakeRuntime();
    const initialize = vi.fn().mockRejectedValueOnce(new Error("credential=secret-test-value")).mockResolvedValue(runtime.runtime);
    const handler = createHostedHandler({ initialize });
    const first = response();
    await handler(request, first);
    expect(first.statusCode).toBe(503);
    expect(first.body).not.toContain("secret-test-value");
    expect(first.headers["Cache-Control"]).toBe("no-store");
    await handler(request, response());
    expect(initialize).toHaveBeenCalledTimes(2);
  });
  it("bounds stalled initialization, fences repeated requests and closes late success", async () => {
    vi.useFakeTimers();
    const pending = deferred<HostedRuntime>();
    const initialize = vi.fn(() => pending.promise);
    const handler = createHostedHandler({ initialize, initializationTimeoutMs: 100 });
    const first = response();
    const serving = handler(request, first);
    await vi.advanceTimersByTimeAsync(101);
    await serving;
    expect(first.statusCode).toBe(503);
    await handler(request, response());
    expect(initialize).toHaveBeenCalledOnce();
    const late = fakeRuntime();
    pending.resolve(late.runtime);
    await vi.runAllTimersAsync();
    expect(late.close).toHaveBeenCalledOnce();
    expect(late.app).not.toHaveBeenCalled();
    initialize.mockResolvedValue(fakeRuntime().runtime);
    await handler(request, response());
    expect(initialize).toHaveBeenCalledTimes(2);
  });
  it("waits for response completion rather than resolving as Express starts", async () => {
    const output = response();
    const started = deferred<void>();
    const app = vi.fn(() => started.resolve());
    const handler = createHostedHandler({ initialize: async () => ({ app: app as unknown as Express, close: async () => undefined }) });
    let completed = false;
    const running = handler(request, output).then(() => { completed = true; });
    await started.promise;
    expect(completed).toBe(false);
    output.emit("finish");
    await running;
    expect(completed).toBe(true);
  });
});

describe("shared OAuth rate-limit store", () => {
  it("uses parameterized hashed keys and a durable counter with endpoint separation", async () => {
    const query = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ totalHits: 3, resetAt: 1234567890000 }]);
    const store = createGraphRateLimitStore({ query } as unknown as GraphClient, "owner-login");
    store.init!({ windowMs: 1000 } as Options);
    expect(await store.increment("client-address")).toEqual({ totalHits: 3, resetTime: new Date(1234567890000) });
    expect(query.mock.calls[1]?.[1]).toMatchObject({ windowMs: 1000, key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(query.mock.calls)).not.toContain("client-address");
    expect(store.localKeys).toBe(false);
    expect(createGraphRateLimitStore({ query } as unknown as GraphClient, "consent").prefix).not.toBe(store.prefix);
  });
  it("fails closed on storage failure or invalid counter result", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const store = createGraphRateLimitStore({ query } as unknown as GraphClient, "token");
    await expect(store.increment("gateway")).rejects.toThrow(/could not be established/);
    query.mockRejectedValue(new Error("test outage"));
    await expect(store.increment("gateway")).rejects.toThrow("test outage");
  });
});
