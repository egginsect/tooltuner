import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { COMPLETE, Grant, InnerTool, newId, provenanceOf, canonicalDigest, type CallRecorder, type Version } from "../../src/contracts.js";
import { createGatewayCore } from "../../src/gateway/core.js";
import { assertContext, builtinDescription, validateToolArgs } from "../../src/gateway/registry.js";
import { versionDigest, validateVersion } from "../../src/db/registry.js";
import { boundedTimeout } from "../../src/gateway/upstream.js";
import type { GraphClient } from "../../src/db/client.js";

function context(groups: ("user" | "development" | "management")[] = ["user"]) {
  const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: "owner", label: "test", groups,
    allow: { apps: ["textkit"], tools: {} }, created_at: new Date().toISOString() });
  return { grant, principal: { owner_id: "owner", grant_id: grant.grant_id, subject: "caller", client_id: "client", session_id: null } };
}

describe("gateway schema and identity boundaries", () => {
  it("validates draft 2020-12 including nested required fields before admission", () => {
    const tool = InnerTool.parse({ name: "nested", description: "test", input_schema: z.toJSONSchema(z.object({ body: z.object({ count: z.number().int().positive() }).strict() }).strict()),
      effects: { read_only: false, destructive: false, idempotent: false, open_world: false } });
    expect(() => validateToolArgs(tool, { body: { count: 3 } })).not.toThrow();
    expect(() => validateToolArgs(tool, { body: { count: -1 } })).toThrow(expect.objectContaining({ shape: expect.objectContaining({ code: "invalid_args", field_path: "args" }) }));
    expect(() => validateToolArgs(tool, { body: { count: 3, owner_id: "other" } })).toThrow();
  });

  it("never reuses an $id validator compiled for a different version", () => {
    const effects = { read_only: true, destructive: false, idempotent: true, open_world: false };
    const tool = { name: "tool", description: "", effects, input_schema: { $id: "urn:fixture:shared", type: "object", properties: { value: { type: "number" } }, required: ["value"] } };
    validateToolArgs(tool, { value: 1 });
    expect(() => validateToolArgs({ ...tool, input_schema: { ...tool.input_schema, properties: { value: { type: "string" } } } }, { value: 1 })).toThrow();
  });

  it("rejects mismatched or revoked contexts", () => {
    const ctx = context();
    expect(() => assertContext({ ...ctx, principal: { ...ctx.principal, owner_id: "other" } })).toThrow();
    expect(() => assertContext({ ...ctx, principal: { ...ctx.principal, grant_id: newId("grant") } })).toThrow();
    expect(() => assertContext({ ...ctx, grant: { ...ctx.grant, revoked_at: new Date().toISOString() } })).toThrow();
  });

  it("bounds timeouts and requires a recorder", () => {
    expect(() => boundedTimeout(0)).toThrow();
    expect(() => boundedTimeout(30_001)).toThrow();
    expect(() => boundedTimeout(Number.NaN)).toThrow();
    expect(boundedTimeout(50)).toBe(50);
    expect(() => createGatewayCore({ db: {} as GraphClient, recorder: undefined as unknown as CallRecorder })).toThrow(/CallRecorder/);
  });

  it("derives builtin discovery solely from grant groups and implemented handlers", () => {
    const handlers = { report_feedback: vi.fn(), get_context: vi.fn(), create_packet: vi.fn() };
    expect(builtinDescription(context(), handlers).tools.map((tool) => tool.name)).toEqual(["report_feedback"]);
    expect(builtinDescription(context(["development"]), handlers).tools.map((tool) => tool.name)).toEqual(["get_context"]);
    expect(builtinDescription(context(["management"]), handlers).tools.map((tool) => tool.name)).toEqual(["create_packet"]);
    expect(builtinDescription(context(["user", "development", "management"]), handlers).tools.map((tool) => tool.name)).toEqual(["report_feedback", "get_context", "create_packet"]);
    expect(() => builtinDescription(context(), handlers, "missing")).toThrow();
  });

  it("denies skipped-catalog and human dispatch before touching persistence", async () => {
    const query = vi.fn();
    const recorder = { admit: vi.fn(), complete: vi.fn(), findIdempotent: vi.fn() };
    const core = createGatewayCore({ db: { roQuery: query } as unknown as GraphClient, recorder, handlers: { get_context: vi.fn() } });
    for (const tool of ["activate", "merge", "rollback"]) {
      await expect(core.dispatch(context(["development", "management"]), { application: "flywheel", tool, args: {} })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    }
    await expect(core.dispatch(context(["development"]), { application: "textkit", tool: "word_count", args: {} })).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(query).not.toHaveBeenCalled();
    expect(recorder.admit).not.toHaveBeenCalled();
  });

  it("checks immutable content and schema digests", () => {
    const body = { schema_version: 1 as const, owner_id: "owner", created_at: new Date().toISOString(), provenance: provenanceOf("seed", null), completeness: COMPLETE,
      version_id: newId("version"), application: "textkit", label: "v1", parent_version_id: null, source: { repo_id: "fixture", commit_sha: "a".repeat(40) },
      tools: [], schema_digest: canonicalDigest({ tools: [] }), runtime_target: { kind: "mcp_streamable_http" as const, url: "http://127.0.0.1:8790/mcp", environment: "local" as const, deployment_id: null },
      auth_config_ref: null, verified_provenance: { method: "owner_config" as const, job_id: null, packet_id: null }, state: "ready" as const,
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
    const version: Version = { ...body, digest: versionDigest(body) };
    expect(validateVersion(version)).toEqual(version);
    expect(() => validateVersion({ ...version, runtime_target: { ...version.runtime_target, url: "http://127.0.0.1:8791/mcp" } })).toThrow();
    expect(() => validateVersion({ ...version, schema_digest: canonicalDigest({ changed: true }) })).toThrow();
  });
});
