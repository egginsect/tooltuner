import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { loadConfig, resolveToolTunerEnvironment } from "./config.js";
import { GraphClient } from "./db/client.js";
import { createRuntime } from "./runtime.js";

export interface HostedRuntime {
  app: Express;
  close(): Promise<void>;
}

/** Compose request-only services. No listener, signal handlers, or public-origin probe. */
export async function startHostedRuntime(environment: NodeJS.ProcessEnv = process.env): Promise<HostedRuntime> {
  environment = resolveToolTunerEnvironment(environment);
  const config = loadConfig({ ...environment, FLYWHEEL_RUNTIME_MODE: undefined, TOOLTUNER_RUNTIME_MODE: "hosted" });
  const db = await GraphClient.connect(config.database);
  try {
    const runtime = await createRuntime({ config, db, environment });
    return { app: runtime.app, async close() {
      try { await runtime.closeCredentials(); } finally { await db.close(); }
    } };
  } catch (error) {
    await db.close();
    throw error;
  }
}

/** One warm-instance initialization promise, never an OAuth/session security store. */
export function createHostedHandler(options: {
  initialize?: () => Promise<HostedRuntime>;
  initializationTimeoutMs?: number;
} = {}) {
  const initialize = options.initialize ?? (() => startHostedRuntime());
  const timeoutMs = options.initializationTimeoutMs ?? 25_000;
  let initialization: Promise<HostedRuntime> | undefined;

  function getRuntime(): Promise<HostedRuntime> {
    if (initialization) return initialization;
    let expired = false;
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.resolve().then(initialize);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error("Hosted initialization deadline exceeded")); }, timeoutMs);
    });
    const current = Promise.race([work, timeout]);
    initialization = current;
    // Keep a timed-out initialization fenced until it settles. Repeated requests
    // cannot create overlapping abandoned database connections. Late success is closed.
    void work.then(async (runtime) => {
      if (expired) await runtime.close();
    }).catch(() => undefined).finally(() => {
      if (timer) clearTimeout(timer);
      if (expired && initialization === current) initialization = undefined;
    });
    void current.catch(() => {
      if (!expired && initialization === current) initialization = undefined;
    });
    return current;
  }

  return async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let runtime: HostedRuntime;
    try { runtime = await getRuntime(); }
    catch {
      if (!response.headersSent && !response.destroyed) {
        response.statusCode = 503;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Retry-After", "5");
        response.end(JSON.stringify({ error: { code: "storage_unavailable", message: "Hosted gateway initialization is unavailable; verify service configuration and storage", retryable: true, outcome_certainty: "not_executed" } }));
      }
      return;
    }
    if (response.destroyed) return;
    await new Promise<void>((resolve) => {
      const finished = () => {
        response.off("finish", finished);
        response.off("close", finished);
        resolve();
      };
      response.once("finish", finished);
      response.once("close", finished);
      runtime.app(request, response);
    });
  };
}
