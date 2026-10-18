import {
  DescribeInput, DispatchInput, FlywheelError, FLYWHEEL_APP, HUMAN_ONLY_ACTIONS,
  type CallRecorder, type FlywheelHandlers,
} from "../contracts.js";
import { listApplications, getStable } from "../db/registry.js";
import type { GraphClient } from "../db/client.js";
import { appVisible, canUseTool } from "../policy.js";
import type { GatewayContext, GatewayCore } from "./mcp.js";
import { assertContext, builtinDescription, BUILTIN_VERSION, catalogCompleteness, resolveVersion, upstreamVisible } from "./registry.js";
import { createDispatch } from "./dispatch.js";
import { boundedTimeout, type UpstreamOptions } from "./upstream.js";

export interface GatewayCoreOptions extends UpstreamOptions {
  db: GraphClient;
  recorder: CallRecorder;
  handlers?: FlywheelHandlers;
}

export function createGatewayCore(options: GatewayCoreOptions): GatewayCore {
  if (!options.recorder) throw new TypeError("createGatewayCore requires a durable CallRecorder.");
  boundedTimeout(options.timeoutMs);
  const handlers = options.handlers ?? {};
  const dispatch = createDispatch({ ...options, handlers });
  const checkVisible = (ctx: GatewayContext, application: string) => {
    assertContext(ctx);
    if (!(application === FLYWHEEL_APP ? appVisible(ctx.grant, application, handlers) : upstreamVisible(ctx, application))) {
      throw new FlywheelError("not_found", "Application was not found.", { fieldPath: "application" });
    }
  };
  return {
    async listApps(ctx) {
      assertContext(ctx);
      const apps = [];
      for (const app of await listApplications(options.db, ctx.principal.owner_id)) {
        if (app.application === FLYWHEEL_APP || app.kind !== "upstream" || !upstreamVisible(ctx, app.application)) continue;
        apps.push({ application: app.application, description: app.description, stable_version: (await getStable(options.db, app.owner_id, app.application))?.version_id ?? null });
      }
      if (appVisible(ctx.grant, FLYWHEEL_APP, handlers)) apps.push({ application: FLYWHEEL_APP, description: "Feedback and improvement operations", stable_version: BUILTIN_VERSION });
      return { apps, completeness: catalogCompleteness() };
    },
    async describe(ctx, raw) {
      const input = parseGatewayInput(DescribeInput, raw);
      checkVisible(ctx, input.application);
      if (input.application === FLYWHEEL_APP) return builtinDescription(ctx, handlers, input.version);
      const version = await resolveVersion(options.db, ctx.principal.owner_id, input.application, input.version);
      return { application: input.application, resolved_version: version.version_id, schema_digest: version.schema_digest,
        tools: version.tools.filter((tool) => !HUMAN_ONLY_ACTIONS.includes(tool.name as typeof HUMAN_ONLY_ACTIONS[number]) && canUseTool(ctx.grant, input.application, tool.name)) };
    },
    async dispatch(ctx, raw) {
      assertContext(ctx);
      const input = structuredClone(parseGatewayInput(DispatchInput, raw));
      return dispatch(ctx, input);
    },
  };
}

export function parseGatewayInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FlywheelError("invalid_args", issue?.message ?? "Invalid gateway input.", { fieldPath: issue?.path.map(String).join(".") || "args" });
  }
  return parsed.data;
}
