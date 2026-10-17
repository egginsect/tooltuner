/** Composition exports for the graph-backed gateway. */
export { createGatewayCore, type GatewayCoreOptions } from "./core.js";
export type { GatewayCore, GatewayContext } from "./mcp.js";
export { resolveVersion, BUILTIN_VERSION, createPreviewRegistry, type PreviewRegistryOptions, type PreviewRegistryProject } from "./registry.js";
export { callUpstream, readUpstreamCatalog, type UpstreamOptions, type UpstreamTarget } from "./upstream.js";
export { REGISTRY_INDEX_SPECS } from "../db/registry.js";
export { createCredentialMediator, createEnvironmentCredentialStore, createCredentialHelperStore, type CredentialMediator, type CredentialStore } from "./credentials.js";
export { createProtectedPreviewVerifier, type ProtectedPreviewTarget, type ProtectedPreviewProject, type ProtectedRuntimeVerification } from "./preview.js";
