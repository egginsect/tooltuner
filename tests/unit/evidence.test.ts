import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, LIMITS, newId, type CallAdmission, type Principal } from "../../src/contracts.js";
import { StorageError } from "../../src/errors.js";
import type { GraphClient } from "../../src/db/client.js";
import { createEvidenceService, boundedCapture, sanitize } from "../../src/flywheel/evidence.js";
import { evidenceStorage } from "../../src/db/evidence.js";

describe("bounded sanitized capture", () => {
  it("redacts structured keys and secrets/PII embedded in otherwise ordinary strings", () => {
    const raw = { nested: { api_key: "private-value", email: "private@example.org" }, note:
      "Bearer credential-123 password=hidden sk-proj-abcdefghijklmnop https://alice:pass@example.org/path?token=hidden person@example.org 123-45-6789" };
    const result = boundedCapture(raw);
    expect(result.truncated).toBe(false);
    expect(result.redacted_paths).toEqual(["/nested/api_key", "/nested/email", "/note"]);
    for (const secret of ["private-value", "private@example.org", "credential-123", "hidden", "abcdefghijklmnop", "alice:pass", "person@example.org", "123-45-6789"]) {
      expect(result.content_json).not.toContain(secret);
    }
    expect(JSON.parse(result.content_json)).toMatchObject({ nested: { api_key: "[REDACTED]" } });
    const embedded = boundedCapture({ text: 'Quoted credentials: {"access_token":"hidden-json-value"}\nCookie: session=hidden-session\nContact: (415) 555-2671' });
    for (const secret of ["hidden-json-value", "hidden-session", "555-2671"]) expect(embedded.content_json).not.toContain(secret);
  });

  it("bounds UTF-8 bytes and remains parseable without treating a preview as complete input", () => {
    const result = boundedCapture({ text: "🌊".repeat(10_000) });
    expect(Buffer.byteLength(result.content_json, "utf8")).toBeLessThanOrEqual(LIMITS.maxEvidenceBytes);
    expect(result.truncated).toBe(true);
    expect(JSON.parse(result.content_json)).toHaveProperty("truncated", true);
  });

  it("canonicalizes object keys, preserves array order, and marks unsupported nesting", () => {
    expect(boundedCapture({ b: 2, a: [2, 1] }).content_json).toBe('{"a":[2,1],"b":2}');
    const cycle: Record<string, unknown> = {}; cycle["self"] = cycle;
    expect(sanitize(cycle).redacted_paths).toEqual(["/self"]);
    expect(canonicalDigest({ b: 2, a: 1 })).toEqual(canonicalDigest({ a: 1, b: 2 }));
    expect(canonicalJson({ z: undefined, a: null })).toBe('{"a":null}');
  });
});

describe("honest storage outcomes", () => {
  it("preserves unknown timeouts without fabricating a receipt", async () => {
    await expect(evidenceStorage(async () => { throw new StorageError("storage_unavailable", "timeout", { outcomeCertainty: "unknown" }); }))
      .rejects.toMatchObject({ shape: { code: "storage_unavailable", outcome_certainty: "unknown" } });
    await expect(evidenceStorage(async () => { throw new StorageError("storage_unavailable", "closed", { outcomeCertainty: "not_executed" }); }))
      .rejects.toMatchObject({ shape: { code: "storage_unavailable", outcome_certainty: "not_executed" } });
  });

  it("cannot admit against an unavailable injected store and never falls back", async () => {
    const db = { roQuery: async () => { throw new StorageError("storage_unavailable", "unavailable"); } } as unknown as GraphClient;
    const principal: Principal = { owner_id: "test", subject: "test", grant_id: newId("grant"), client_id: "test", session_id: null };
    const admission: CallAdmission = { principal, application: "sample", tool: "echo", requested_version: null,
      resolved_version: newId("version"), schema_digest: canonicalDigest({}), idempotency_key: null, args: {}, causal_refs: [] };
    await expect(createEvidenceService(db).recorder.admit(admission)).rejects.toMatchObject({ shape: { code: "storage_unavailable" } });
  });
});
