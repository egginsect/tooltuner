/** RFC 8628 owner acquisition for environments without a reachable loopback callback. */
import { registerClient } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthTokensSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { FlywheelError, canonicalDigest } from "../contracts.js";
import { getUpstreamAccount } from "../db/registry.js";
import { OAuthCredential, acquisitionProvenance, credentialFetch, discoverAccountIssuer, secureUrl, validateStandardTokens } from "../gateway/credentials.js";
import { configured, finishLink, verifyResourceMetadata, type LinkOptions } from "./link.js";

const DeviceResponse = z.object({ device_code: z.string().min(1).max(4096), user_code: z.string().min(1).max(128),
  verification_uri: z.string().url(), verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().positive().max(1800), interval: z.number().int().positive().max(300).default(5) });
const unavailable = () => new FlywheelError("operation_unavailable", "Owner device authorization failed or expired; no account link was acknowledged. Start a fresh authorization when ready.");

export async function beginDeviceAccountLink(options: LinkOptions & {
  onUserCode(value: { verification_uri: string; verification_uri_complete?: string; user_code: string; expires_in: number }): void | Promise<void>;
}) {
  if (options.account.validation_mode !== "standard_oauth" || options.store.custody !== "encrypted_postgres" ||
      !options.store.put || !options.account.credential_ref.startsWith("postgres:")) throw new FlywheelError("forbidden", "Device authorization requires explicit standard OAuth and encrypted PostgreSQL custody.");
  // A fresh dynamic public client keeps this bounded flow free of imported credentials.
  if (options.account.client_id) throw new FlywheelError("forbidden", "Device authorization requires a fresh public client registration.");
  const initial = configured(options, "pending-device-registration");
  if (await getUpstreamAccount(options.db, initial.account.owner_id, initial.account.auth_config_ref)) throw new FlywheelError("ingest_conflict", "The device account reference is already linked; use a new reference for fresh authorization.");
  const timeoutMs = options.timeoutMs ?? 600_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1_800_000) throw new TypeError("Device timeout must be between 100 and 1800000 ms.");
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, Math.min(10_000, deadline - Date.now()));
  try {
    await verifyResourceMetadata(initial.account, initial.binding, remaining());
    const metadata = await discoverAccountIssuer(initial.account, remaining());
    const endpoint = (metadata as unknown as Record<string, unknown>).device_authorization_endpoint;
    if (typeof endpoint !== "string" || secureUrl(endpoint, initial.account.environment).origin !== new URL(initial.account.issuer).origin ||
        !metadata.grant_types_supported?.includes("urn:ietf:params:oauth:grant-type:device_code")) throw new FlywheelError("forbidden", "The pinned issuer does not advertise a supported device authorization endpoint.");
    const client = await registerClient(initial.account.issuer, { metadata, clientMetadata: { client_name: "MCP Flywheel owner device link",
      redirect_uris: [], grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"], response_types: [], token_endpoint_auth_method: "none" },
      scope: initial.account.scopes.join(" "), fetchFn: credentialFetch(initial.account, remaining()) });
    if (client.issuer !== undefined && client.issuer !== initial.account.issuer) throw unavailable();
    if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== "none" || client.client_secret) throw new FlywheelError("forbidden", "Device authorization requires an issuer-registered public client.");
    const linked = configured(options, client.client_id);
    const form = (body: URLSearchParams) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const response = await credentialFetch(linked.account, remaining())(endpoint, form(new URLSearchParams({ client_id: client.client_id,
      resource: linked.binding.resource, scope: linked.account.scopes.join(" ") })));
    if (!response.ok) throw unavailable();
    const device = DeviceResponse.parse(await response.json());
    const verification = secureUrl(device.verification_uri, linked.account.environment);
    if (verification.origin !== new URL(linked.account.issuer).origin) throw unavailable();
    if (device.verification_uri_complete) {
      const complete = new URL(device.verification_uri_complete);
      if (complete.origin !== verification.origin || complete.username || complete.password || complete.hash) throw unavailable();
    }
    const expires = Math.min(deadline, Date.now() + device.expires_in * 1000);
    let handoffTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        options.onUserCode({ verification_uri: device.verification_uri, ...(device.verification_uri_complete ? { verification_uri_complete: device.verification_uri_complete } : {}), user_code: device.user_code, expires_in: device.expires_in }),
        new Promise<never>((_resolve, reject) => { handoffTimer = setTimeout(() => reject(unavailable()), Math.max(1, expires - Date.now())); }),
      ]);
    } finally { if (handoffTimer) clearTimeout(handoffTimer); }
    let interval = device.interval * 1000;
    while (Date.now() + interval < expires) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (Date.now() >= expires) break;
      const poll = await credentialFetch(linked.account, Math.max(1, Math.min(remaining(), expires - Date.now())))(metadata.token_endpoint!, form(new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: client.client_id, device_code: device.device_code, resource: linked.binding.resource })));
      const raw: unknown = await poll.json();
      if (!poll.ok) {
        const error = z.object({ error: z.string() }).parse(raw).error;
        if (poll.status === 400 && error === "authorization_pending") continue;
        if (poll.status === 400 && error === "slow_down") { interval += 5000; continue; }
        throw unavailable();
      }
      // Success is single-use: never retry an uncertain exchange or custody write.
      if (Date.now() >= expires) throw unavailable();
      const tokens = OAuthTokensSchema.parse(raw);
      if (tokens.issuer !== undefined && tokens.issuer !== linked.account.issuer) throw unavailable();
      const acquisition = acquisitionProvenance(linked.account, linked.binding, "device_authorization");
      const secret = OAuthCredential.parse({ issuer: linked.account.issuer, environment: linked.account.environment,
        resource: linked.binding.resource, audience: linked.binding.audience, obtained_at: acquisition.acquired_at,
        client: { ...client, issuer: linked.account.issuer }, tokens: { ...tokens, issuer: linked.account.issuer },
        acquisition });
      validateStandardTokens(linked.account, linked.binding, secret);
      const prior = await getUpstreamAccount(options.db, linked.account.owner_id, linked.account.auth_config_ref);
      if (prior && canonicalDigest(prior, ["created_at"]) !== canonicalDigest(linked.account, ["created_at"])) throw unavailable();
      await options.store.put(linked.account.credential_ref, secret, linked.binding);
      return await finishLink({ ...options, timeoutMs: remaining() }, client.client_id);
    }
    throw unavailable();
  } catch (error) { if (error instanceof FlywheelError) throw error; throw unavailable(); }
}
