import { createHash } from "node:crypto";
import type { Store } from "express-rate-limit";
import type { GraphClient } from "./client.js";
import type { IndexSpec } from "./schema.js";
import { StorageError } from "../errors.js";

export const RATE_LIMIT_INDEX_SPECS: readonly IndexSpec[] = [
  { label: "OAuthRateLimit", property: "key", unique: true },
  { label: "OAuthRateLimit", property: "reset_at" },
];

/** Shared fixed-window counters; no instance-local security state or raw client addresses. */
export function createGraphRateLimitStore(db: GraphClient, endpoint: string): Store {
  const prefix = `oauth:${endpoint}:`;
  const digest = (key: string) => createHash("sha256").update(prefix).update(key).digest("hex");
  let windowMs = 15 * 60_000;
  return {
    localKeys: false,
    prefix,
    init(options) { windowMs = options.windowMs; },
    async increment(key) {
      // A bounded opportunistic cleanup needs no background worker or instance timer.
      await db.query("MATCH (b:OAuthRateLimit) WHERE b.reset_at <= timestamp() WITH b LIMIT 100 DELETE b", {}, "pruning expired OAuth rate limits");
      const rows = await db.query<{ totalHits: number; resetAt: number }>(
        `MERGE (b:OAuthRateLimit {key: $key})
         ON CREATE SET b.hits = 0, b.reset_at = 0
         SET b.hits = CASE WHEN b.reset_at <= timestamp() THEN 1 ELSE b.hits + 1 END,
             b.reset_at = CASE WHEN b.reset_at <= timestamp() THEN timestamp() + $windowMs ELSE b.reset_at END
         RETURN b.hits AS totalHits, b.reset_at AS resetAt`,
        { key: digest(key), windowMs }, "incrementing shared OAuth rate limit",
      );
      const row = rows[0];
      if (!row || !Number.isSafeInteger(row.totalHits) || row.totalHits < 1 || !Number.isSafeInteger(row.resetAt)) {
        throw new StorageError("storage_unavailable", "Shared OAuth rate limit could not be established");
      }
      return { totalHits: row.totalHits, resetTime: new Date(row.resetAt) };
    },
    async decrement(key) {
      await db.query("MATCH (b:OAuthRateLimit {key: $key}) SET b.hits = CASE WHEN b.hits > 0 THEN b.hits - 1 ELSE 0 END", { key: digest(key) }, "decrementing OAuth rate limit");
    },
    async resetKey(key) {
      await db.query("MATCH (b:OAuthRateLimit {key: $key}) DELETE b", { key: digest(key) }, "resetting OAuth rate limit");
    },
  };
}
