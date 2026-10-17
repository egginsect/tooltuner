/**
 * Grant enforcement (TOO-77). Pure functions used by discovery (list_apps,
 * describe) and by dispatch, so filtering and enforcement can never diverge.
 */
import {
  FLYWHEEL_APP,
  FLYWHEEL_OPERATIONS,
  FlywheelError,
  UPSTREAM_TOOL_GROUP,
  type FlywheelHandlers,
  type FlywheelOperation,
  type Grant,
  type ToolGroup,
} from "../contracts.js";

export function isFlywheelOperation(tool: string): tool is FlywheelOperation {
  return Object.hasOwn(FLYWHEEL_OPERATIONS, tool);
}

/** Group a tool belongs to; null for unknown flywheel operations. */
export function toolGroupFor(application: string, tool: string): ToolGroup | null {
  if (application !== FLYWHEEL_APP) return UPSTREAM_TOOL_GROUP;
  return isFlywheelOperation(tool) ? FLYWHEEL_OPERATIONS[tool].group : null;
}

function isActive(grant: Grant): boolean {
  return grant.revoked_at === null;
}

/** App data scope: may this grant act on (or read about) `application`? */
export function appInScope(grant: Grant, application: string): boolean {
  if (!isActive(grant)) return false;
  return grant.allow.apps.includes("*") || grant.allow.apps.includes(application);
}

function toolAllowlisted(grant: Grant, application: string, tool: string): boolean {
  const list = grant.allow.tools[application];
  return list === undefined || list.includes(tool);
}

/** Whether the grant may invoke `tool` of `application` (group + app + tool allowlists). */
export function canUseTool(grant: Grant, application: string, tool: string): boolean {
  if (!isActive(grant)) return false;
  const group = toolGroupFor(application, tool);
  if (group === null || !grant.groups.includes(group)) return false;
  if (!toolAllowlisted(grant, application, tool)) return false;
  // Flywheel operations are scoped per target app inside their handlers.
  return application === FLYWHEEL_APP || appInScope(grant, application);
}

/** Flywheel operations this grant may see: implemented and allowed. */
export function visibleFlywheelOperations(grant: Grant, handlers: FlywheelHandlers): FlywheelOperation[] {
  return (Object.keys(FLYWHEEL_OPERATIONS) as FlywheelOperation[]).filter(
    (op) => handlers[op] !== undefined && canUseTool(grant, FLYWHEEL_APP, op),
  );
}

/** Whether an application appears in list_apps for this grant. */
export function appVisible(grant: Grant, application: string, handlers: FlywheelHandlers): boolean {
  if (application === FLYWHEEL_APP) return visibleFlywheelOperations(grant, handlers).length > 0;
  return appInScope(grant, application);
}

/**
 * Dispatch-time enforcement. Invisible apps are `not_found` (no existence leak);
 * a visible app with a disallowed or human-only tool is `forbidden`; an allowed
 * but unimplemented flywheel operation is `operation_unavailable`.
 */
export function assertCanDispatch(
  grant: Grant,
  application: string,
  tool: string,
  handlers: FlywheelHandlers,
): void {
  if (!appVisible(grant, application, handlers)) {
    throw new FlywheelError("not_found", `Application "${application}" was not found.`, { fieldPath: "application" });
  }
  if (!canUseTool(grant, application, tool)) {
    throw new FlywheelError("forbidden", `This grant does not allow "${application}.${tool}".`, { fieldPath: "tool" });
  }
  if (application === FLYWHEEL_APP && handlers[tool as FlywheelOperation] === undefined) {
    throw new FlywheelError("operation_unavailable", `Operation "${tool}" is not available on this server.`, {
      fieldPath: "tool",
    });
  }
}

/** Data-level guard for flywheel handlers that target an application. */
export function assertAppInScope(grant: Grant, application: string): void {
  if (!appInScope(grant, application)) {
    throw new FlywheelError("not_found", `Application "${application}" was not found.`, { fieldPath: "application" });
  }
}

export function assertRepoAllowed(grant: Grant, repoId: string): void {
  if (!grant.allow.repos.includes(repoId)) {
    throw new FlywheelError("forbidden", `Repository "${repoId}" is not allowlisted for this grant.`, {
      fieldPath: "repo_id",
    });
  }
}
