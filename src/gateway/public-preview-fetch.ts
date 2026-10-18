/** Anonymous, exact-origin HTTPS transport for provider-inspected immutable Vercel previews. */
import { lookup } from "node:dns";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { FlywheelError } from "../contracts.js";

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) denied.addSubnet(address, prefix, "ipv4");

export function isPublicIpv4(address: string): boolean {
  return isIP(address) === 4 && !denied.check(address, "ipv4");
}

export function validatePublicPreviewUrl(value: string): URL {
  const url = new URL(value);
  if (url.href !== value || url.protocol !== "https:" || !/^[a-zA-Z0-9-]+\.vercel\.app$/.test(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) {
    throw new FlywheelError("forbidden", "Public previews require the exact provider-inspected HTTPS Vercel deployment endpoint.");
  }
  return url;
}

async function boundedRequestBody(request: Request, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  const aborted = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", aborted, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read(); signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024) { void reader.cancel().catch(() => undefined); throw new FlywheelError("invalid_args", "Public MCP request exceeds the size limit."); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", aborted); reader.releaseLock(); }
}

/** Each socket receives a verified DNS result directly; no preflight/re-resolution gap.
 * IPv6-only previews are deliberately unsupported. TLS verification/SNI retain the hostname.
 */
export function createPublicPreviewFetch(endpoint: string, policy: "public_ipv4_pinned" | "provider_verified_vercel" = "public_ipv4_pinned"): typeof fetch {
  if (!["public_ipv4_pinned", "provider_verified_vercel"].includes(policy)) throw new Error("Unknown public preview network policy");
  const target = validatePublicPreviewUrl(endpoint);
  const allowedHeaders = new Set(["accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"]);
  return async (input, init) => {
    const outgoing = new Request(input, init);
    if (outgoing.url !== target.href || !["GET", "POST", "DELETE"].includes(outgoing.method)) {
      throw new FlywheelError("forbidden", "Public MCP requests cannot leave their exact pinned endpoint.");
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of outgoing.headers) {
      if (!allowedHeaders.has(key)) throw new FlywheelError("forbidden", "Public preview requests cannot carry credentials or unapproved headers.");
      headers[key] = value;
    }
    const signal = AbortSignal.any([outgoing.signal, AbortSignal.timeout(20_000)]);
    signal.throwIfAborted();
    const body = await boundedRequestBody(outgoing, signal);
    if (policy === "provider_verified_vercel") {
      // Explicit provider-host trust mode. Supported environment proxies retain normal TLS;
      // this path makes no DNS-pinning claim and is never selected after a DNS failure.
      const response = await fetch(target, { method: outgoing.method, headers, signal,
        redirect: "error", credentials: "omit", ...(body ? { body: new Uint8Array(body) } : {}) });
      if (response.redirected || response.url !== target.href || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel(); throw new Error("Public preview response left the exact endpoint");
      }
      const safeHeaders = new Headers(response.headers); safeHeaders.delete("set-cookie");
      let size = 0;
      const bounded = response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > 4 * 1024 * 1024) { controller.error(new Error("Public MCP response exceeds the size limit")); return; }
        controller.enqueue(chunk);
      } }), { signal });
      return new Response(bounded ?? null, { status: response.status, headers: safeHeaders });
    }
    return new Promise<Response>((resolve, reject) => {
      const req = request(target, { method: outgoing.method, headers, signal, family: 4,
        // The socket connects to this address without a second DNS resolution.
        lookup(hostname, _options, callback) {
          if (hostname !== target.hostname) { callback(new Error("Unexpected lookup hostname"), "", 4); return; }
          lookup(hostname, { family: 4, all: true }, (error, addresses) => {
            if (error || !addresses.length || addresses.some(({ address }) => !isPublicIpv4(address))) {
              callback(new Error("Public preview DNS did not resolve exclusively to public IPv4 addresses"), "", 4); return;
            }
            callback(null, addresses[0]!.address, 4);
          });
        },
      }, (incoming) => {
        const status = incoming.statusCode ?? 502;
        if (status >= 300 && status < 400) { incoming.destroy(); reject(new Error("Public preview redirects are forbidden")); return; }
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value !== undefined && key !== "set-cookie") responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        if ([204, 205, 304].includes(status)) { incoming.resume(); resolve(new Response(null, { status, headers: responseHeaders })); return; }
        let size = 0;
        const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) { incoming.destroy(); callback(new Error("Public MCP response exceeds the size limit")); }
          else callback(null, chunk);
        } });
        incoming.on("error", (error) => bounded.destroy(error));
        const abortBody = () => bounded.destroy(signal.reason instanceof Error ? signal.reason : new Error("Public MCP response aborted"));
        signal.addEventListener("abort", abortBody, { once: true });
        if (signal.aborted) abortBody();
        bounded.once("close", () => { signal.removeEventListener("abort", abortBody); incoming.destroy(); });
        incoming.pipe(bounded);
        resolve(new Response(Readable.toWeb(bounded) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }));
      });
      req.once("error", reject);
      req.end(body);
    });
  };
}
