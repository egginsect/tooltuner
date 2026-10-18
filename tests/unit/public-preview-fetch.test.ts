import { beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { lookup } from "node:dns";
import { request } from "node:https";
import { createPublicPreviewFetch, isPublicIpv4, validatePublicPreviewUrl } from "../../src/gateway/public-preview-fetch.js";
vi.mock("node:dns", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
const endpoint = "https://sample-unique.vercel.app/mcp";
let addresses: { address: string; family: number }[];
let status: number;
let responseBody: string;
let pinned: string | undefined;
beforeEach(() => {
  vi.clearAllMocks(); addresses = [{ address: "76.76.21.21", family: 4 }]; status = 200; responseBody = '{"ok":true}'; pinned = undefined;
  vi.mocked(lookup).mockImplementation(((_host: string, _options: unknown, callback: Function) => callback(null, addresses)) as typeof lookup);
  vi.mocked(request).mockImplementation(((_url: URL, options: { lookup: Function; signal: AbortSignal }, callback: Function) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => options.lookup("sample-unique.vercel.app", {}, (error: Error | null, address: string) => {
      if (error) { req.emit("error", error); return; }
      pinned = address;
      const incoming = Object.assign(Readable.from([Buffer.from(responseBody)]), { statusCode: status, headers: { "content-type": "application/json", "set-cookie": "secret=ignored" } });
      callback(incoming);
    });
    return req;
  }) as unknown as typeof request);
});
it("pins a public DNS address to the actual TLS connection and strips response cookies", async () => {
  const response = await createPublicPreviewFetch(endpoint)(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", "mcp-session-id": "synthetic-session" }, body: '{}' });
  expect(pinned).toBe("76.76.21.21"); expect(await response.json()).toEqual({ ok: true }); expect(response.headers.has("set-cookie")).toBe(false);
  expect(request).toHaveBeenCalledWith(new URL(endpoint), expect.objectContaining({ family: 4, signal: expect.any(AbortSignal), headers: expect.not.objectContaining({ authorization: expect.anything(), cookie: expect.anything() }) }), expect.any(Function));
});
it.each(["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.1.1", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.1.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "::ffff:127.0.0.1"])("rejects nonpublic DNS address %s at connection", async (address) => {
  expect(isPublicIpv4(address)).toBe(false); addresses = [{ address, family: address.includes(":") ? 6 : 4 }];
  await expect(createPublicPreviewFetch(endpoint)(endpoint)).rejects.toThrow(/DNS/); expect(pinned).toBeUndefined();
});
it("rejects mixed public/private DNS answers rather than choosing the public one", async () => {
  addresses.push({ address: "127.0.0.1", family: 4 });
  await expect(createPublicPreviewFetch(endpoint)(endpoint)).rejects.toThrow(/DNS/); expect(pinned).toBeUndefined();
});
it.each(["http://sample-unique.vercel.app/mcp", "https://localhost/mcp", "https://127.0.0.1/mcp", "https://[::1]/mcp", "https://sample.vercel.app.evil.example/mcp", "https://sample-unique.vercel.app:8443/mcp", "https://user:pass@sample-unique.vercel.app/mcp", "https://sample-unique.vercel.app/mcp?token=secret", "https://sample-unique.vercel.app/mcp#fragment"])("rejects unsafe endpoint %s", (url) => {
  expect(() => validatePublicPreviewUrl(url)).toThrow();
});
it("rejects redirects, cross-path requests and all authorization/cookie headers", async () => {
  const fetcher = createPublicPreviewFetch(endpoint); status = 302;
  await expect(fetcher(endpoint)).rejects.toThrow(/redirects/);
  expect(request).toHaveBeenCalledTimes(1);
  await expect(fetcher("https://sample-unique.vercel.app/other")).rejects.toThrow(/exact pinned/);
  for (const header of ["authorization", "cookie", "x-vercel-protection-bypass", "host"]) await expect(fetcher(endpoint, { headers: { [header]: "secret" } })).rejects.toThrow(/credentials/);
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds response size and honors an already aborted request before socket creation", async () => {
  const fetcher = createPublicPreviewFetch(endpoint);
  const controller = new AbortController(); controller.abort();
  await expect(fetcher(endpoint, { signal: controller.signal })).rejects.toThrow(); expect(request).not.toHaveBeenCalled();
  responseBody = "x".repeat(4 * 1024 * 1024 + 1);
  const response = await fetcher(endpoint); await expect(response.text()).rejects.toThrow(/size limit/);
});
it("uses the supported proxy-compatible fetch only when explicitly selected, without credential or redirect forwarding", async () => {
  const upstream = Object.defineProperty(new Response('{"ok":true}', { headers: { "set-cookie": "secret=ignored" } }), "url", { value: endpoint });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
  try {
    const response = await createPublicPreviewFetch(endpoint, "provider_verified_vercel")(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: '{}' });
    expect(await response.json()).toEqual({ ok: true }); expect(response.headers.has("set-cookie")).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(new URL(endpoint), expect.objectContaining({ redirect: "error", credentials: "omit", signal: expect.any(AbortSignal), headers: { "content-type": "application/json" } }));
    expect(lookup).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    await expect(createPublicPreviewFetch(endpoint, "provider_verified_vercel")("https://other.vercel.app/mcp")).rejects.toThrow(/exact pinned/);
    await expect(createPublicPreviewFetch(endpoint, "provider_verified_vercel")(endpoint, { headers: { authorization: "secret" } })).rejects.toThrow(/credentials/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { fetcher.mockRestore(); }
});
it("does not fall back from rejected direct DNS to the proxy-compatible fetch", async () => {
  addresses = [{ address: "127.0.0.1", family: 4 }];
  const fetcher = vi.spyOn(globalThis, "fetch");
  try { await expect(createPublicPreviewFetch(endpoint)(endpoint)).rejects.toThrow(/DNS/); expect(fetcher).not.toHaveBeenCalled(); }
  finally { fetcher.mockRestore(); }
});
it("rejects changed response URLs and redirected responses in provider-host mode", async () => {
  const upstream = Object.defineProperty(new Response('bad'), "url", { value: "https://other.vercel.app/mcp" });
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
  try { await expect(createPublicPreviewFetch(endpoint, "provider_verified_vercel")(endpoint)).rejects.toThrow(/exact endpoint/); }
  finally { fetcher.mockRestore(); }
});
it("aborts a stalled streamed request before making any socket request", async () => {
  const controller = new AbortController(); const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const input = new Request(endpoint, { method: "POST", body, signal: controller.signal, duplex: "half" } as RequestInit);
  const pending = createPublicPreviewFetch(endpoint)(input);
  controller.abort(new Error("synthetic deadline"));
  await expect(pending).rejects.toThrow(/synthetic deadline/);
  expect(request).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalled();
});
it("bounds streamed request bodies incrementally and cancels oversized producers", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel });
  const input = new Request(endpoint, { method: "POST", body, duplex: "half" } as RequestInit);
  await expect(createPublicPreviewFetch(endpoint)(input)).rejects.toThrow(/size limit/);
  expect(request).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalled();
});
it("propagates cancellation and aborts after response headers in provider-host mode", async () => {
  for (const action of ["cancel", "abort"] as const) {
    const cancel = vi.fn(); const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const upstream = Object.defineProperty(new Response(source), "url", { value: endpoint });
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
    try {
      const response = await createPublicPreviewFetch(endpoint, "provider_verified_vercel")(endpoint, { signal: controller.signal });
      if (action === "cancel") await response.body!.cancel();
      else { const pending = response.text(); controller.abort(new Error("synthetic response deadline")); await expect(pending).rejects.toThrow(/synthetic response deadline/); }
      await new Promise((resolve) => setTimeout(resolve, 0)); expect(cancel).toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  }
});
