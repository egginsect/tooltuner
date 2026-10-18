import { randomUUID } from "node:crypto";
import { discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { FlywheelError, canonicalDigest, type InnerTool } from "../contracts.js";
import { CredentialBinding } from "../db/registry.js";
import { secureUrl, type CredentialMediator } from "./credentials.js";
import { boundedTimeout, readUpstreamCatalog } from "./upstream.js";
import { validateToolArgs } from "./registry.js";

/** Supplied only after the trusted manager's fresh provider identity/provenance readback. */
export interface ProtectedPreviewTarget {
  url: string; deploymentId: string; application: string; ownerId: string;
  repoId: string; commitSha: string; projectId: string; teamId: string; schemaDigest?: string;
}
export interface ProtectedPreviewProject {
  ownerId: string; application: string; repoId: string; projectId: string; teamId: string;
  authConfigRef: string; issuer: string; scopes: string[]; mcpPath: string;
  /** Local integration fixtures must opt in and name their exact origin. Remote previews use HTTPS. */
  localOrigin?: string;
}
export interface ProtectedRuntimeVerification {
  tools: InnerTool[]; schema_digest: string; auth_config_ref: string;
  initializeVerified: boolean; authVerified: boolean; resourceVerified: boolean;
}
export interface ProtectedPreviewVerifierOptions {
  credentials: CredentialMediator;
  projects: readonly ProtectedPreviewProject[];
  timeoutMs?: number;
}

export function createProtectedPreviewVerifier(options: ProtectedPreviewVerifierOptions) {
  const timeoutMs = boundedTimeout(options.timeoutMs ?? 20_000);
  return { async verifyRuntime(target: ProtectedPreviewTarget): Promise<ProtectedRuntimeVerification> {
    const project = options.projects.find((p) => p.ownerId === target.ownerId && p.application === target.application && p.repoId === target.repoId &&
      p.projectId === target.projectId && p.teamId === target.teamId);
    if (!project || !target.deploymentId || !/^[a-f0-9]{40}$/.test(target.commitSha)) throw new FlywheelError("forbidden", "Preview target lacks the configured owner/repository/project and exact deployment provenance.");
    const environment = project.localOrigin ? "local" as const : "preview" as const;
    const url = secureUrl(target.url, environment);
    if (url.href !== target.url || url.pathname !== project.mcpPath || (project.localOrigin && url.origin !== project.localOrigin) ||
        (!project.localOrigin && !/^[a-zA-Z0-9-]+\.vercel\.app$/.test(url.hostname))) throw new FlywheelError("forbidden", "Preview verification requires the manager-verified immutable deployment URL and configured MCP path.");
    const binding = CredentialBinding.parse({ schema_version: 1, created_at: new Date().toISOString(), owner_id: target.ownerId, application: target.application,
      repo_id: target.repoId, commit_sha: target.commitSha, deployment_id: target.deploymentId, url: target.url,
      auth_config_ref: project.authConfigRef, resource: target.url, audience: target.url, scopes: project.scopes, environment, issuer: project.issuer });
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new FlywheelError("version_unavailable", "Protected preview verification exceeded its deadline.")); }, timeoutMs); });
    const request: typeof fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : input.toString());
      if (secureUrl(requestUrl.href, environment).origin !== url.origin) throw new FlywheelError("forbidden", "Protected resource metadata escaped the approved deployment origin.");
      return fetch(input, { ...init, redirect: "error", signal: controller.signal });
    };
    const initialize = (headers: Record<string, string> = {}) => request(url, { method: "POST", headers: { ...headers,
      "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "flywheel-protected-preview-probe", version: "1" } } }) });
    try {
      return await Promise.race([deadline, (async () => {
        const anonymous = await initialize();
        if (anonymous.status !== 401) { await anonymous.body?.cancel(); throw new FlywheelError("version_unavailable", "The preview does not reject unauthenticated MCP initialization."); }
        const challenge = extractWWWAuthenticateParams(anonymous);
        await anonymous.body?.cancel();
        if (!challenge.resourceMetadataUrl || challenge.resourceMetadataUrl.origin !== url.origin) throw new FlywheelError("version_unavailable", "Preview authentication challenge must name same-origin protected resource metadata.");
        const metadata = await discoverOAuthProtectedResourceMetadata(target.url, { resourceMetadataUrl: challenge.resourceMetadataUrl }, request);
        if (metadata.resource !== binding.resource || !metadata.authorization_servers?.includes(project.issuer) ||
            metadata.authorization_servers.some((issuer) => issuer !== project.issuer) ||
            project.scopes.some((scope) => !metadata.scopes_supported?.includes(scope))) throw new FlywheelError("version_unavailable", "Preview OAuth resource, authorization server or supported scopes do not match the approved target.");
        controller.signal.throwIfAborted();
        const invalid = await initialize({ Authorization: `Bearer invalid-preview-probe-${randomUUID()}` });
        await invalid.body?.cancel();
        if (invalid.status !== 401 && invalid.status !== 403) throw new FlywheelError("version_unavailable", "The protected preview accepted an invalid bearer token.");
        // Mint a separate token for a deliberate same-origin resource probe. Never use a production token.
        const negativeResource = new URL(`/.well-known/flywheel-negative-resource/${encodeURIComponent(target.deploymentId)}`, url).href;
        const negativeBinding = CredentialBinding.parse({ ...binding, resource: negativeResource, audience: negativeResource });
        const wrongResourceHeaders = await options.credentials.authorizeCandidate(negativeBinding);
        controller.signal.throwIfAborted();
        const denied = await initialize(wrongResourceHeaders);
        await denied.body?.cancel();
        if (denied.status !== 401 && denied.status !== 403) throw new FlywheelError("version_unavailable", "The protected preview accepted a token issued for a different resource/audience.");
        const headers = await options.credentials.authorizeCandidate(binding);
        controller.signal.throwIfAborted();
        const tools = await readUpstreamCatalog({ owner_id: binding.owner_id, application: binding.application,
          source: { repo_id: binding.repo_id, commit_sha: binding.commit_sha }, version_id: `ver_${canonicalDigest({ deployment: binding.deployment_id }).slice(7, 33)}`,
          runtime_target: { kind: "mcp_streamable_http", url: binding.url, deployment_id: binding.deployment_id, environment }, auth_config_ref: binding.auth_config_ref },
        { timeoutMs, resolveAuth: async () => headers });
        if (tools.length === 0 || new Set(tools.map((tool) => tool.name)).size !== tools.length) throw new FlywheelError("version_unavailable", "Protected preview returned an empty or ambiguous tool catalog.");
        for (const tool of tools) {
          try { validateToolArgs(tool, {}); }
          catch (error) { if (!(error instanceof FlywheelError) || error.shape.code !== "invalid_args") throw error; }
        }
        const schema_digest = canonicalDigest({ tools });
        if (target.schemaDigest !== undefined && target.schemaDigest !== schema_digest) throw new FlywheelError("version_unavailable", "Protected preview schema changed since its immutable registration.");
        controller.signal.throwIfAborted();
        await options.credentials.approveTarget(binding);
        return { tools, schema_digest, auth_config_ref: binding.auth_config_ref, initializeVerified: true, authVerified: true, resourceVerified: true };
      })()]);
    } catch (error) {
      if (error instanceof FlywheelError) throw error;
      throw new FlywheelError("version_unavailable", "Protected preview OAuth/resource/schema verification failed; no ready preview was acknowledged.");
    } finally { if (timer) clearTimeout(timer); controller.abort(); }
  } };
}
