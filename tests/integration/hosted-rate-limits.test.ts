import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Options } from "express-rate-limit";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { createGraphRateLimitStore, RATE_LIMIT_INDEX_SPECS } from "../../src/db/rate-limits.js";

it("shares atomic OAuth counters across fresh instances, isolates endpoints and expires old buckets", async () => {
  const graph = `hosted_limit_${randomUUID().replaceAll("-", "")}`;
  const options = { url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph,
    username: process.env.FALKORDB_USERNAME, password: process.env.FALKORDB_PASSWORD };
  const first = await GraphClient.connect(options);
  let second: GraphClient | undefined;
  try {
    await bootstrapSchema(first, RATE_LIMIT_INDEX_SPECS);
    second = await GraphClient.connect(options);
    const a = createGraphRateLimitStore(first, "owner-login");
    const b = createGraphRateLimitStore(second, "owner-login");
    a.init!({ windowMs: 60_000 } as Options);
    b.init!({ windowMs: 60_000 } as Options);
    const hits = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).increment("gateway")));
    expect(hits.map((hit) => hit.totalHits).sort((x, y) => x - y)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(new Set(hits.map((hit) => hit.resetTime?.getTime())).size).toBe(1);
    const independent = createGraphRateLimitStore(second, "consent");
    expect((await independent.increment("gateway")).totalHits).toBe(1);
    await second.close();
    second = await GraphClient.connect(options);
    const fresh = createGraphRateLimitStore(second, "owner-login");
    expect((await fresh.increment("gateway")).totalHits).toBe(13);
    await first.query("MATCH (b:OAuthRateLimit) SET b.reset_at = 0");
    expect((await fresh.increment("gateway")).totalHits).toBe(1);
    await fresh.resetKey("gateway");
    expect((await fresh.increment("gateway")).totalHits).toBe(1);
  } finally {
    await second?.close();
    await first.dropGraph();
    await first.close();
  }
}, 30_000);
