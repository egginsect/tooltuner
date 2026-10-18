import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  discoverOAuthProtectedResourceMetadata, startAuthorization, exchangeAuthorization, registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthClientInformationSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { FlywheelError, canonicalDigest } from "../contracts.js";
import {
  UpstreamAccount, CredentialBinding, putUpstreamAccount, putCredentialBinding, getUpstreamAccount,
} from "../db/registry.js";
import type { GraphClient } from "../db/client.js";
import {
  OAuthCredential, authorizeCredential, credentialFetch, discoverAccountIssuer, secureUrl, type CredentialStore,
} from "../gateway/credentials.js";
import { readUpstreamCatalog } from "../gateway/upstream.js";
import type { OwnerDecisionContext } from "./versions.js";

export type LinkAccountConfig = Omit<UpstreamAccount, "schema_version" | "owner_id" | "created_at" | "client_id"> & { client_id?: string };
export type LinkTargetConfig = Omit<CredentialBinding, "schema_version" | "owner_id" | "created_at" | "auth_config_ref" | "application" | "repo_id" | "environment" | "issuer" | "scopes">;
export interface LinkOptions {
  db: GraphClient; owner: OwnerDecisionContext; store: CredentialStore;
  account: LinkAccountConfig; target: LinkTargetConfig; timeoutMs?: number;
  /** Optional external reference for pre-registered client information, including its issuer. */
  client_ref?: string;
}

function configured(options: LinkOptions, clientId: string) {
  if (!options.owner.owner_id || !options.owner.subject) throw new FlywheelError("forbidden", "Upstream linking requires the trusted local owner context.");
  const created_at = new Date().toISOString();
  const account = UpstreamAccount.parse({ ...options.account, client_id: clientId, schema_version: 1, owner_id: options.owner.owner_id, created_at });
  const binding = CredentialBinding.parse({ ...options.target, schema_version: 1, owner_id: account.owner_id, created_at,
    auth_config_ref: account.auth_config_ref, application: account.application, repo_id: account.repo_id, scopes: account.scopes, environment: account.environment, issuer: account.issuer });
  secureUrl(account.issuer, account.environment); secureUrl(binding.url, binding.environment); secureUrl(binding.resource, binding.environment);
  return { account, binding };
}

async function finishLink(options: LinkOptions, clientId: string) {
  const { account, binding } = configured(options, clientId);
  const prior = await getUpstreamAccount(options.db, account.owner_id, account.auth_config_ref);
  if (prior && canonicalDigest(prior, ["created_at"]) !== canonicalDigest(account, ["created_at"])) throw new FlywheelError("ingest_conflict", "This logical account reference is already linked to a different authority.");
  const metadata = await discoverOAuthProtectedResourceMetadata(binding.url, {}, async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (secureUrl(url.href, binding.environment).origin !== new URL(binding.url).origin) throw new FlywheelError("forbidden", "Resource discovery escaped the explicitly configured upstream origin.");
    return fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
  });
  if (metadata.resource !== binding.resource || metadata.authorization_servers?.length !== 1 || metadata.authorization_servers[0] !== account.issuer ||
      account.scopes.some((scope) => !metadata.scopes_supported?.includes(scope))) throw new FlywheelError("forbidden", "Configured upstream resource metadata does not match the intended OAuth issuer/resource/scopes.");
  const headers = await authorizeCredential(account, binding, options.store, options.timeoutMs ?? 10_000);
  const tools = await readUpstreamCatalog({ owner_id: binding.owner_id, application: binding.application, source: { repo_id: binding.repo_id, commit_sha: binding.commit_sha },
    version_id: `ver_${canonicalDigest({ deployment: binding.deployment_id }).slice(7, 33)}`, runtime_target: { kind: "mcp_streamable_http", url: binding.url,
      deployment_id: binding.deployment_id, environment: binding.environment }, auth_config_ref: binding.auth_config_ref },
  { timeoutMs: Math.min(options.timeoutMs ?? 10_000, 30_000), resolveAuth: async () => headers });
  const saved = await putUpstreamAccount(options.db, account);
  await putCredentialBinding(options.db, binding);
  return { account: saved, binding, schema_digest: canonicalDigest({ tools }) };
}

/** Owner configured an environment/helper/PostgreSQL reference containing an SDK OAuth credential document. */
export async function linkUpstreamAccount(options: LinkOptions) {
  let secret: OAuthCredential;
  try { secret = OAuthCredential.parse(await options.store.get(options.account.credential_ref, configured(options, options.account.client_id ?? "pending-client").binding)); }
  catch { throw new FlywheelError("operation_unavailable", "Configure a valid external OAuth credential reference before linking the account."); }
  if (options.account.client_id && options.account.client_id !== secret.client.client_id) throw new FlywheelError("forbidden", "Configured OAuth client differs from the external credential authority.");
  try { return await finishLink(options, secret.client.client_id); }
  catch (error) { if (error instanceof FlywheelError) throw error; throw new FlywheelError("operation_unavailable", "Upstream account discovery and protected SDK initialization did not verify; no successful link was acknowledged."); }
}

/** SDK PKCE flow with a state-checked loopback callback. Only the owner CLI calls this helper.
 * The callback URL contains no tokens; all code/verifier/token material stays in memory or the helper.
 */
export async function beginUpstreamAccountLink(options: LinkOptions & {
  onAuthorizationUrl(url: URL): void | Promise<void>;
}): Promise<Awaited<ReturnType<typeof linkUpstreamAccount>>> {
  if (!options.store.put || !/^(helper|postgres):/.test(options.account.credential_ref)) throw new FlywheelError("operation_unavailable", "Browser linking requires a writable helper or PostgreSQL credential reference.");
  const initial = configured(options, options.account.client_id ?? "pending-dynamic-registration");
  const prior = await getUpstreamAccount(options.db, initial.account.owner_id, initial.account.auth_config_ref);
  if (prior && canonicalDigest(prior, ["created_at"]) !== canonicalDigest(initial.account, ["created_at"])) throw new FlywheelError("ingest_conflict", "This account reference is already linked; reuse its configured client and external credential authority.");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new TypeError("Owner link timeout must be between 100 and 300000 ms.");
  const state = randomBytes(32).toString("base64url");
  let acceptCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  let consumed = false;
  const callback = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const received = url.searchParams.get("state") ?? "";
    const valid = Buffer.byteLength(received) === Buffer.byteLength(state) && timingSafeEqual(Buffer.from(received), Buffer.from(state));
    if (request.method !== "GET" || url.pathname !== "/callback" || !valid || consumed || url.searchParams.getAll("state").length !== 1 ||
        url.searchParams.getAll("code").length > 1 || url.searchParams.getAll("iss").length > 1 ||
        (url.searchParams.has("iss") && url.searchParams.get("iss") !== options.account.issuer)) { response.writeHead(400).end("Invalid owner authorization callback."); return; }
    consumed = true;
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error") || code.length > 4096) { response.writeHead(400).end("Authorization was not completed."); rejectCode(new FlywheelError("operation_unavailable", "The upstream owner authorization was denied or incomplete.")); return; }
    response.writeHead(200, { "content-type": "text/plain" }).end("Owner account authorization received. Return to the CLI.");
    acceptCode(code);
  });
  await new Promise<void>((resolve, reject) => { callback.once("error", reject); callback.listen(0, "127.0.0.1", resolve); });
  const address = callback.address();
  if (!address || typeof address === "string") throw new Error("Owner callback did not obtain a loopback port.");
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  let timer: NodeJS.Timeout | undefined;
  const codePromise = new Promise<string>((resolve, reject) => { acceptCode = resolve; rejectCode = reject; timer = setTimeout(() => reject(new FlywheelError("operation_unavailable", "Owner authorization timed out; no account link was acknowledged.")), timeoutMs); });
  // A discovery failure can happen before the callback is awaited.
  void codePromise.catch(() => undefined);
  try {
    const issuerConfig = options.account;
    const metadata = await discoverAccountIssuer(issuerConfig, Math.min(timeoutMs, 30_000));
    if (!metadata.authorization_endpoint) throw new FlywheelError("operation_unavailable", "The configured issuer has no verified authorization endpoint.");
    const authorizationEndpoint = secureUrl(metadata.authorization_endpoint, issuerConfig.environment);
    if (authorizationEndpoint.origin !== new URL(issuerConfig.issuer).origin || !metadata.code_challenge_methods_supported?.includes("S256")) throw new FlywheelError("forbidden", "Owner authorization requires issuer-bound S256 PKCE.");
    // Pre-registered confidential clients are read only from the helper; no secret CLI argument.
    let client;
    if (options.account.client_id) {
      const external = await options.store.get(options.client_ref ?? options.account.credential_ref, initial.binding);
      const bundle = OAuthCredential.safeParse(external);
      client = bundle.success ? bundle.data.client : OAuthClientInformationSchema.parse(external);
      if (client.issuer !== options.account.issuer || client.client_id !== options.account.client_id) throw new FlywheelError("forbidden", "Pre-registered client belongs to another issuer.");
    } else {
      client = await registerClient(options.account.issuer, { metadata, clientMetadata: { client_name: "MCP Flywheel owner link", redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }, scope: options.account.scopes.join(" "),
      fetchFn: credentialFetch(issuerConfig, Math.min(timeoutMs, 30_000)) });
    }
    const { authorizationUrl, codeVerifier } = await startAuthorization(options.account.issuer, { metadata, clientInformation: client, redirectUrl: redirectUri,
      scope: options.account.scopes.join(" "), state, resource: options.target.resource });
    if (authorizationUrl.origin !== new URL(options.account.issuer).origin) throw new FlywheelError("forbidden", "Owner consent escaped the configured issuer.");
    await Promise.race([Promise.resolve(options.onAuthorizationUrl(authorizationUrl)), codePromise.then(() => undefined)]);
    const authorizationCode = await codePromise;
    const tokens = await exchangeAuthorization(options.account.issuer, { metadata, clientInformation: client, authorizationCode, codeVerifier,
      redirectUri, resource: options.target.resource, fetchFn: credentialFetch(issuerConfig, Math.min(timeoutMs, 30_000)) });
    const secret = OAuthCredential.parse({ issuer: options.account.issuer, environment: options.account.environment, resource: options.target.resource,
      audience: options.target.audience, obtained_at: Math.floor(Date.now() / 1000), client: { ...client, issuer: options.account.issuer }, tokens: { ...tokens, issuer: options.account.issuer } });
    const account = configured(options, client.client_id).account;
    const existing = await getUpstreamAccount(options.db, account.owner_id, account.auth_config_ref);
    if (existing && canonicalDigest(existing, ["created_at"]) !== canonicalDigest(account, ["created_at"])) throw new FlywheelError("ingest_conflict", "The account reference changed during authorization; the credential helper was not overwritten.");
    await options.store.put(options.account.credential_ref, secret, configured(options, client.client_id).binding);
    return await finishLink({ ...options, timeoutMs: Math.min(timeoutMs, 30_000) }, client.client_id);
  } catch (error) {
    if (error instanceof FlywheelError) throw error;
    throw new FlywheelError("operation_unavailable", "Owner OAuth linking failed; reconcile the external credential helper before trying again.");
  } finally {
    if (timer) clearTimeout(timer);
    consumed = true;
    await new Promise<void>((resolve) => { callback.close(() => resolve()); callback.closeAllConnections(); });
  }
}
