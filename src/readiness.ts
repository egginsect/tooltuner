/**
 * Startup readiness report. Each item states what is true right now: `ready` only when it was
 * actually verified, `unverified` when configured but not yet checkable, `not_configured` for
 * optional features, `failed` when a required step failed. Nothing is reported ready because a
 * local port is open.
 */
import type { Config } from "./config.js";

export type ReadinessStatus = "ready" | "unverified" | "not_configured" | "failed";

export interface ReadinessItem {
  name: string;
  status: ReadinessStatus;
  /** Critical items block serving protected dispatch when not ready. */
  critical: boolean;
  detail: string;
  /** Exact next step when the item is not ready. */
  action?: string;
}

/**
 * Items derived from configuration alone. Features whose code is still a stub are reported
 * `unverified` when configured, never `ready`.
 */
export function configReadiness(config: Config): ReadinessItem[] {
  const items: ReadinessItem[] = [];

  items.push(
    config.publicOrigin === undefined
      ? { name: "public_origin", status: "not_configured", critical: false, detail: "FLYWHEEL_PUBLIC_ORIGIN is unset; only local access is available", action: "Set FLYWHEEL_PUBLIC_ORIGIN to the fixed HTTPS tunnel origin (see .env.example)" }
      : { name: "public_origin", status: "unverified", critical: false, detail: `${config.publicOrigin} is configured but not yet verified to reach this process` },
  );

  const oauthMissing = [
    config.oauth.issuer === undefined ? "OAUTH_ISSUER" : undefined,
    config.oauth.resource === undefined ? "OAUTH_RESOURCE (or FLYWHEEL_PUBLIC_ORIGIN)" : undefined,
    config.oauth.allowedRedirectUris.length === 0 ? "OAUTH_ALLOWED_REDIRECT_URIS" : undefined,
    config.oauth.signingKeyRef === undefined ? "OAUTH_SIGNING_KEY_REF" : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  items.push(
    oauthMissing.length > 0
      ? { name: "flywheel_oauth", status: "not_configured", critical: true, detail: `Missing: ${oauthMissing.join(", ")}`, action: "Protected dispatch stays disabled until OAuth is configured (TOO-77)" }
      : { name: "flywheel_oauth", status: "unverified", critical: true, detail: "OAuth configuration present; the OAuth server is not implemented in the foundation" },
  );

  items.push({
    name: "upstream_linking",
    status: "not_configured",
    critical: false,
    detail: "Owner upstream account linking is not implemented yet",
    action: "Implemented by the gateway worker (TOO-77)",
  });

  items.push(
    config.registry.fixtureRegistryPath === undefined
      ? { name: "fixtures", status: "not_configured", critical: false, detail: "FIXTURE_REGISTRY_PATH is unset; no applications are registered", action: "Register fixtures with TOO-64" }
      : { name: "fixtures", status: "unverified", critical: false, detail: `Registry file ${config.registry.fixtureRegistryPath} is configured but not loaded by the foundation` },
  );

  items.push(
    config.runner.configPath === undefined
      ? { name: "runner", status: "not_configured", critical: false, detail: "RUNNER_CONFIG_PATH is unset; coding jobs cannot start", action: "Configure the runner with TOO-78" }
      : { name: "runner", status: "unverified", critical: false, detail: `Runner config ${config.runner.configPath} is referenced but not loaded` },
  );

  const vercelMissing = [
    config.vercel.projectId === undefined ? "VERCEL_PROJECT_ID" : undefined,
    config.vercel.tokenPresent ? undefined : "VERCEL_TOKEN",
  ].filter((entry): entry is string => entry !== undefined);
  items.push(
    vercelMissing.length > 0
      ? { name: "vercel", status: "not_configured", critical: false, detail: `Missing: ${vercelMissing.join(", ")}`, action: "Previews need an existing Vercel project and a token in the manager environment only (TOO-78)" }
      : { name: "vercel", status: "unverified", critical: false, detail: `Project ${config.vercel.projectId ?? ""} configured; token present (value never printed)` },
  );

  return items;
}

export function formatReadiness(items: readonly ReadinessItem[]): string[] {
  const width = Math.max(...items.map((item) => item.name.length));
  return items.map((item) => {
    const marker = item.status === "ready" ? "[ready]         " : item.status === "failed" ? "[FAILED]        " : item.status === "unverified" ? "[unverified]    " : "[not_configured]";
    const action = item.action === undefined ? "" : `  -> ${item.action}`;
    return `${marker} ${item.name.padEnd(width)}  ${item.detail}${action}`;
  });
}
