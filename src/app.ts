import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StorageError } from "./errors.js";
import type { Lifecycle } from "./lifecycle.js";

export const SERVICE_NAME = "tooltuner";

export interface StorageStatus {
  graph: string;
  schema_version: number;
}

export interface AppDeps {
  /** Random per-process ID returned by /healthz so a public origin can be proven to reach this process. */
  instanceId: string;
  lifecycle: Lifecycle;
  /** Verifies FalkorDB connectivity and schema compatibility; throws StorageError when unavailable. */
  checkStorage: () => Promise<StorageStatus>;
  /**
   * Extension points: each mount registers routes on the shared express app. The gateway adds
   * /mcp, OAuth (the SDK's express auth router) and discovery routes here; nothing else in this
   * file needs to change. Mounts run before the 404 and error handlers.
   */
  mounts?: readonly ((app: Express) => void)[];
}

/** Build the express app. It does not listen; `main` in src/server.ts owns the listener. */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", async (_request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    if (!deps.lifecycle.admissionOpen) {
      response.status(503).json({ status: "draining", service: SERVICE_NAME, instance_id: deps.instanceId, pending_calls: deps.lifecycle.pending().length });
      return;
    }
    try {
      const storage = await deps.checkStorage();
      response.json({
        status: "ok",
        service: SERVICE_NAME,
        instance_id: deps.instanceId,
        checks: { falkordb: { status: "ok", schema_version: storage.schema_version } },
      });
    } catch (error) {
      const body = publicStorageError(error, "storage_unavailable", "Storage check failed");
      response.status(503).json({ status: "unavailable", service: SERVICE_NAME, instance_id: deps.instanceId, checks: { falkordb: { status: "failed" } }, error: body });
    }
  });

  for (const mount of deps.mounts ?? []) mount(app);

  app.use((request: Request, response: Response) => {
    response.status(404).json({ error: { code: "not_found", message: `No route for ${request.method} ${request.path}`, retryable: false, outcome_certainty: "not_executed" } });
  });

  // Express recognizes error handlers by their four-argument signature.
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const body = publicStorageError(error, "internal_error", "The server could not process this request");
    response.status(500).json({ error: body });
  });

  return app;
}

/** Public diagnostics retain error classification, never driver text or topology. */
function publicStorageError(error: unknown, fallback: "storage_unavailable" | "internal_error", message: string) {
  if (error instanceof StorageError) return { ...error.toBody(), message };
  return new StorageError(fallback, message).toBody();
}
