import { spawn } from "node:child_process";
import { z } from "zod";
import { discoverAuthorizationServerMetadata, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthTokensSchema, OAuthClientInformationSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { FlywheelError, canonicalJson } from "../contracts.js";
import {
  UpstreamAccount, CredentialBinding, getUpstreamAccount, getCredentialBinding, putCredentialBinding,
} from "../db/registry.js";
import type { GraphClient } from "../db/client.js";
import { boundedTimeout, type UpstreamTarget } from "./upstream.js";

/** Implementations must never print requests, responses or underlying helper errors. */
export interface CredentialStore {
  get(reference: string): Promise<unknown>;
  put?(reference: string, secret: unknown): Promise<void>;
}

/** An owner-supplied JSON environment variable, not a token passed on the CLI. Read-only. */
export function createEnvironmentCredentialStore(environment: Readonly<Record<string, string | undefined>>): CredentialStore {
  return { async get(reference) {
    const match = /^env:([A-Z][A-Z0-9_]*)$/.exec(reference);
    if (!match || !environment[match[1]!]) throw new FlywheelError("operation_unavailable", "The configured environment credential reference is unavailable.");
    try { return JSON.parse(environment[match[1]!]!); }
    catch { throw new FlywheelError("operation_unavailable", "The environment credential reference must contain a valid OAuth credential document."); }
  } };
}

/** Fixed credential-helper protocol: one JSON request on stdin, one JSON response on stdout.
 * The helper owns encrypted/keychain storage. No shell, secret argv, or inherited provider environment.
 */
export function createCredentialHelperStore(options: { executable: string; homeDirectory?: string; timeoutMs?: number }): CredentialStore {
  if (!options.executable.startsWith("/")) throw new TypeError("The credential helper must use an absolute executable path.");
  const timeout = boundedTimeout(options.timeoutMs);
  const invoke = (operation: "get" | "put", reference: string, value?: unknown): Promise<unknown> => new Promise((resolve, reject) => {
    if (!/^helper:[a-zA-Z0-9._/-]+$/.test(reference)) { reject(new FlywheelError("invalid_args", "Expected a named helper credential reference.")); return; }
    const child = spawn(options.executable, [], { env: { PATH: "/usr/bin:/bin", HOME: options.homeDirectory ?? "/nonexistent" }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new FlywheelError("operation_unavailable", "Credential helper failed; inspect its local configuration without printing secrets.")); } };
    const timer = setTimeout(() => { fail(); child.kill("SIGKILL"); }, timeout);
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (Buffer.byteLength(output) > 64 * 1024) { fail(); child.kill("SIGKILL"); } });
    child.stderr.resume();
    child.stdin.on("error", fail);
    child.once("error", () => { clearTimeout(timer); fail(); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) { fail(); return; }
      try { const response: unknown = JSON.parse(output); settled = true; resolve(response); }
      catch { fail(); }
    });
    child.stdin.end(canonicalJson({ operation, reference, ...(operation === "put" ? { value } : {}) }));
  });
  return { get: (reference) => invoke("get", reference), async put(reference, value) { const result = await invoke("put", reference, value); if (!(result && typeof result === "object" && "stored" in result && result.stored === true)) throw new FlywheelError("operation_unavailable", "Credential helper did not acknowledge secure persistence."); } };
}

export const OAuthCredential = z.object({
  issuer: z.string().url(), environment: z.enum(["local", "preview", "production"]),
  resource: z.string().url(), audience: z.string().min(1), obtained_at: z.number().int().nonnegative(),
  client: OAuthClientInformationSchema, tokens: OAuthTokensSchema,
}).strict();
export type OAuthCredential = z.infer<typeof OAuthCredential>;

export function secureUrl(value: string, environment: UpstreamAccount["environment"]): URL {
  const url = new URL(value);
  const local = environment === "local" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.hash || url.search) {
    throw new FlywheelError("forbidden", "Credential endpoints must be exact credential-free HTTPS URLs; only explicit local configuration permits loopback HTTP.");
  }
  return url;
}

/** Fetch with an exact origin allowlist, no redirects and bounded time; never carries inbound auth. */
export function credentialFetch(account: Pick<UpstreamAccount, "issuer" | "introspection_url" | "environment">, timeoutMs = 10_000): typeof fetch {
  const issuer = secureUrl(account.issuer, account.environment);
  const inspection = secureUrl(account.introspection_url, account.environment);
  if (inspection.origin !== issuer.origin) throw new FlywheelError("forbidden", "Token introspection must use the configured issuer origin.");
  return async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : input.toString());
    if (secureUrl(target.href, account.environment).origin !== issuer.origin) throw new FlywheelError("forbidden", "OAuth discovery or token endpoint escaped the configured issuer origin.");
    return fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  };
}

export async function discoverAccountIssuer(account: Pick<UpstreamAccount, "issuer" | "introspection_url" | "environment">, timeoutMs = 10_000) {
  try {
    const metadata = await discoverAuthorizationServerMetadata(account.issuer, { fetchFn: credentialFetch(account, timeoutMs) });
    if (!metadata || metadata.issuer !== account.issuer || !metadata.token_endpoint) throw new Error("Issuer mismatch");
    secureUrl(metadata.token_endpoint, account.environment);
    if (new URL(metadata.token_endpoint).origin !== new URL(account.issuer).origin) throw new Error("Token origin mismatch");
    return metadata;
  } catch { throw new FlywheelError("operation_unavailable", "The configured OAuth issuer discovery or token endpoint could not be verified."); }
}

function assertBinding(account: UpstreamAccount, binding: CredentialBinding): void {
  if (account.owner_id !== binding.owner_id || account.application !== binding.application || account.repo_id !== binding.repo_id ||
      account.auth_config_ref !== binding.auth_config_ref || account.issuer !== binding.issuer || account.environment !== binding.environment ||
      binding.scopes.some((scope) => !account.scopes.includes(scope))) throw new FlywheelError("forbidden", "Credential target is outside the linked owner/application/repository/environment authority.");
  secureUrl(binding.url, binding.environment);
  secureUrl(binding.resource, binding.environment);
}

async function readSecret(store: CredentialStore, account: UpstreamAccount): Promise<OAuthCredential> {
  try {
    const secret = OAuthCredential.parse(await store.get(account.credential_ref));
    if (secret.issuer !== account.issuer || secret.environment !== account.environment || secret.client.client_id !== account.client_id ||
        (secret.tokens.issuer && secret.tokens.issuer !== account.issuer) || (secret.client.issuer && secret.client.issuer !== account.issuer)) throw new Error("Credential authority mismatch");
    return secret;
  } catch { throw new FlywheelError("operation_unavailable", "The external credential is unavailable or belongs to a different OAuth authority."); }
}

/** Opaque tokens require authoritative RFC 7662 introspection; unverified JWT decoding is insufficient. */
export async function inspectAccessToken(account: UpstreamAccount, binding: CredentialBinding, secret: OAuthCredential, timeoutMs = 10_000): Promise<void> {
  assertBinding(account, binding);
  const body = new URLSearchParams({ token: secret.tokens.access_token, token_type_hint: "access_token", client_id: account.client_id });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (secret.client.client_secret) headers["authorization"] = `Basic ${Buffer.from(`${encodeURIComponent(account.client_id)}:${encodeURIComponent(secret.client.client_secret)}`).toString("base64")}`;
  try {
    const response = await credentialFetch(account, timeoutMs)(account.introspection_url, { method: "POST", headers, body });
    if (!response.ok) throw new Error("Introspection unavailable");
    const result = z.object({ active: z.literal(true), aud: z.union([z.string(), z.array(z.string()).min(1)]), scope: z.string(),
      client_id: z.string(), iss: z.string().optional(), exp: z.number().optional(), token_type: z.string().optional() }).parse(await response.json());
    const audience = typeof result.aud === "string" ? [result.aud] : result.aud;
    const scopes = result.scope.split(/\s+/u).filter(Boolean);
    if (audience.length !== 1 || audience[0] !== binding.audience || result.client_id !== account.client_id ||
        (result.iss !== undefined && result.iss !== account.issuer) || (result.exp !== undefined && result.exp <= Date.now() / 1000) ||
        (result.token_type !== undefined && result.token_type.toLowerCase() !== "bearer") ||
        binding.scopes.some((scope) => !scopes.includes(scope)) || scopes.some((scope) => !account.scopes.includes(scope))) throw new Error("Resource or scope mismatch");
  } catch { throw new FlywheelError("forbidden", "OAuth token introspection did not prove the exact audience, client, issuer and approved scopes."); }
}

/** Token acquisition uses only the owner's external grant and the SDK's resource-bound refresh. */
export async function authorizeCredential(account: UpstreamAccount, binding: CredentialBinding, store: CredentialStore, timeoutMs = 10_000): Promise<Record<string, string>> {
  assertBinding(account, binding);
  let secret = await readSecret(store, account);
  const expires = secret.tokens.expires_in === undefined ? Infinity : secret.obtained_at + secret.tokens.expires_in;
  if (secret.resource !== binding.resource || secret.audience !== binding.audience || expires < Date.now() / 1000 + 30) {
    if (!secret.tokens.refresh_token || !store.put) throw new FlywheelError("operation_unavailable", "This exact resource needs a renewable owner credential in a writable credential helper.");
    const metadata = await discoverAccountIssuer(account, timeoutMs);
    try {
      const tokens = await refreshAuthorization(account.issuer, { metadata, clientInformation: secret.client, refreshToken: secret.tokens.refresh_token,
        resource: binding.resource, fetchFn: credentialFetch(account, timeoutMs) });
      secret = OAuthCredential.parse({ ...secret, resource: binding.resource, audience: binding.audience, obtained_at: Math.floor(Date.now() / 1000), tokens: { ...tokens, issuer: account.issuer } });
      // Persist a possibly rotated refresh token before any further operation, even if audience validation fails.
      await store.put(account.credential_ref, secret);
    } catch { throw new FlywheelError("operation_unavailable", "Resource-bound OAuth refresh or secure token persistence failed; reconcile the account before retrying."); }
  }
  if (secret.tokens.token_type.toLowerCase() !== "bearer") throw new FlywheelError("forbidden", "Only the configured OAuth Bearer token type is supported.");
  await inspectAccessToken(account, binding, secret, timeoutMs);
  return { Authorization: `Bearer ${secret.tokens.access_token}` };
}

export interface CredentialMediatorOptions { db: GraphClient; store: CredentialStore; timeoutMs?: number }

export function createCredentialMediator(options: CredentialMediatorOptions) {
  const timeout = boundedTimeout(options.timeoutMs ?? 10_000);
  const active = new Map<string, Promise<unknown>>();
  async function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = active.get(key);
    const next = (async () => { await prior?.catch(() => undefined); return work(); })();
    active.set(key, next);
    try { return await next; } finally { if (active.get(key) === next) active.delete(key); }
  }
  async function authorize(binding: CredentialBinding) {
    const account = await getUpstreamAccount(options.db, binding.owner_id, binding.auth_config_ref);
    if (!account) throw new FlywheelError("operation_unavailable", "The owner has not linked this upstream account.");
    return serialize(account.credential_ref, () => authorizeCredential(account, binding, options.store, timeout));
  }
  return {
    /** Trusted verifier/owner helper only; normal dispatch requires the persisted exact binding below. */
    authorizeCandidate: authorize,
    async approveTarget(binding: CredentialBinding) { return putCredentialBinding(options.db, binding); },
    async resolveAuth(reference: string, target: UpstreamTarget): Promise<Record<string, string>> {
      const binding = await getCredentialBinding(options.db, target.owner_id, reference, target.runtime_target.url);
      if (!binding || binding.application !== target.application || binding.repo_id !== target.source.repo_id || binding.commit_sha !== target.source.commit_sha ||
          binding.deployment_id !== target.runtime_target.deployment_id || binding.environment !== target.runtime_target.environment || target.auth_config_ref !== reference) {
        throw new FlywheelError("forbidden", "No verified credential binding exists for this exact owner, application, source and deployment.");
      }
      return authorize(binding);
    },
  };
}
export type CredentialMediator = ReturnType<typeof createCredentialMediator>;
