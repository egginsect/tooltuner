import { createPublicPreviewFetch } from "./public-preview-fetch.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { FlywheelError, LIMITS, type InnerTool, type Version } from "../contracts.js";

export interface UpstreamOptions {
  timeoutMs?: number;
  /** Resolves a server-side reference. Secrets stay out of registry records and responses. */
  resolveAuth?: (reference: string, target: UpstreamTarget) => Promise<Record<string, string>>;
}

export type UpstreamTarget = Pick<Version, "owner_id" | "application" | "version_id" | "source" | "runtime_target" | "auth_config_ref" | "public_access">;

/** A received JSON-RPC error or malformed protocol result, distinct from a tool's isError result. */
export class UpstreamProtocolError extends FlywheelError {}

export function boundedTimeout(timeoutMs: number = LIMITS.dispatchTimeoutMs): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.dispatchTimeoutMs) {
    throw new TypeError(`timeoutMs must be between 1 and ${LIMITS.dispatchTimeoutMs}.`);
  }
  return timeoutMs;
}

async function withClient<T>(
  target: UpstreamTarget,
  options: UpstreamOptions,
  work: (client: Client, signal: AbortSignal, markSent: () => void) => Promise<T>,
): Promise<T> {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const client = new Client({ name: "tooltuner-gateway", version: "1.0.0" });
  const controller = new AbortController();
  let sent = false;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FlywheelError(sent ? "outcome_unknown" : "upstream_error", "Upstream request exceeded its bounded deadline.", { certainty: sent ? "unknown" : "not_executed" }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      let headers: Record<string, string> = {};
      if (target.public_access && (target.auth_config_ref !== null || target.runtime_target.environment !== "preview" || target.public_access.provider !== "vercel")) {
        throw new FlywheelError("forbidden", "Public preview policy cannot resolve credentials or target another environment.");
      }
      if (target.auth_config_ref !== null) {
        if (!options.resolveAuth) throw new FlywheelError("operation_unavailable", "The selected version requires a configured upstream credential resolver.");
        headers = await options.resolveAuth(target.auth_config_ref, target);
      }
      controller.signal.throwIfAborted();
      const transport = new StreamableHTTPClientTransport(new URL(target.runtime_target.url), {
        requestInit: { headers, signal: controller.signal, redirect: "error" },
        ...(target.public_access ? { fetch: createPublicPreviewFetch(target.runtime_target.url, target.public_access.network_policy) } : {}),
      });
      await client.connect(transport, { signal: controller.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
      controller.signal.throwIfAborted();
      return work(client, controller.signal, () => { sent = true; });
    })()]);
  } catch (error) {
    if (error instanceof FlywheelError) throw error;
    if (!sent && error instanceof StreamableHTTPError && (error.code === 404 || error.code === 410)) {
      throw new FlywheelError("version_unavailable", "The pinned deployment endpoint is gone; no fallback is allowed.");
    }
    if (sent && ((error instanceof McpError && error.code !== ErrorCode.RequestTimeout && error.code !== ErrorCode.ConnectionClosed) ||
        error instanceof ZodError || (error instanceof StreamableHTTPError && error.code === -1))) {
      const rejected = error instanceof McpError && [ErrorCode.ParseError, ErrorCode.InvalidRequest, ErrorCode.MethodNotFound, ErrorCode.InvalidParams].includes(error.code);
      throw new UpstreamProtocolError("upstream_error", "The pinned upstream returned a JSON-RPC error or invalid protocol result.", { certainty: rejected ? "not_executed" : "unknown", retryable: false });
    }
    throw new FlywheelError(sent ? "outcome_unknown" : "upstream_error", sent
      ? "Upstream call lost its response; reconcile the recorded call before retrying."
      : "The pinned upstream deployment could not be initialized; verify its URL and credentials.",
    { certainty: sent ? "unknown" : "not_executed" });
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    void client.close().catch(() => undefined);
  }
}

export async function callUpstream(version: Version, tool: string, args: Record<string, unknown>, options: UpstreamOptions = {}) {
  return withClient(version, options, async (client, signal, markSent) => {
    markSent();
    return client.callTool({ name: tool, arguments: args }, CallToolResultSchema, {
      signal, timeout: boundedTimeout(options.timeoutMs), maxTotalTimeout: boundedTimeout(options.timeoutMs),
    });
  });
}

/** Live SDK discovery used by explicit fixture registration, never a fabricated readiness probe. */
export async function readUpstreamCatalog(target: UpstreamTarget, options: UpstreamOptions = {}): Promise<InnerTool[]> {
  return withClient(target, options, async (client, signal) => {
    const tools: InnerTool[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: boundedTimeout(options.timeoutMs) });
      for (const tool of page.tools) tools.push({
        name: tool.name, description: tool.description ?? "", input_schema: tool.inputSchema,
        effects: { read_only: tool.annotations?.readOnlyHint ?? false, destructive: tool.annotations?.destructiveHint ?? true,
          idempotent: tool.annotations?.idempotentHint ?? false, open_world: tool.annotations?.openWorldHint ?? true },
      });
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new FlywheelError("upstream_error", "Upstream tool pagination did not advance.");
      if (cursor) seen.add(cursor);
      if (tools.length > 1000) throw new FlywheelError("upstream_error", "Upstream catalog exceeds the registration limit.");
    } while (cursor);
    return tools;
  });
}
