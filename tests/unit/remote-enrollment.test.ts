import { beforeEach, describe, expect, it, vi } from "vitest";
import { Application, COMPLETE, FlywheelError, canonicalDigest, provenanceOf, type InnerTool, type Version } from "../../src/contracts.js";
import type { GraphClient } from "../../src/db/client.js";
import {
  CredentialBinding, UpstreamAccount, getApplication, getCredentialBinding, getUpstreamAccount, getVersion,
  insertApplication, insertVersion, putCredentialBinding, putUpstreamAccount, recordDecision,
} from "../../src/db/registry.js";
import { callUpstream, readUpstreamCatalog } from "../../src/gateway/upstream.js";
import { enrollLocalApplication, enrollRemoteApplication, type RemoteEnrollmentOptions } from "../../src/cli/enroll.js";

vi.mock("../../src/db/registry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/db/registry.js")>(),
  getApplication: vi.fn(), getCredentialBinding: vi.fn(), getUpstreamAccount: vi.fn(), getVersion: vi.fn(),
  insertApplication: vi.fn(), insertVersion: vi.fn(), putCredentialBinding: vi.fn(), putUpstreamAccount: vi.fn(), recordDecision: vi.fn(),
}));
vi.mock("../../src/gateway/upstream.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/gateway/upstream.js")>(),
  readUpstreamCatalog: vi.fn(), callUpstream: vi.fn(),
}));

const owner = { owner_id: "owner", subject: "trusted-owner" };
const input = {
  application: "remote-app", description: "Protected remote tools", label: "v1",
  source: { repo_id: "owner/remote-app", commit_sha: "a".repeat(40) },
  url: "https://deployment.example/mcp", deployment_id: "deployment-1", environment: "production",
  auth_config_ref: "oauth:remote-app", tools: ["selected"],
};
const effects = { read_only: true, destructive: false, idempotent: true, open_world: false };
const selected: InnerTool = { name: "selected", description: "Selected capability", effects,
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };
const excluded: InnerTool = { name: "excluded", description: "Unselected capability", effects,
  input_schema: { type: "object", properties: { field: { type: "unsupported-schema-type" } } } };
const db = { query: vi.fn(), roQuery: vi.fn() } as unknown as GraphClient;
const resolveAuth = vi.fn(async () => ({ Authorization: "Bearer test-secret-must-not-be-persisted" }));
const options: RemoteEnrollmentOptions = { credentials: { resolveAuth }, timeoutMs: 5000 };
let account: UpstreamAccount;
let binding: CredentialBinding;
let application: Application | null;
let catalog: InnerTool[];
let versions: Version[];

beforeEach(() => {
  vi.clearAllMocks();
  account = UpstreamAccount.parse({ schema_version: 1, owner_id: owner.owner_id, created_at: "2026-01-01T00:00:00Z",
    auth_config_ref: input.auth_config_ref, credential_ref: "env:REMOTE_APP", application: input.application,
    repo_id: input.source.repo_id, environment: input.environment, issuer: "https://issuer.example/",
    introspection_url: "https://issuer.example/introspect", client_id: "client-1", scopes: ["mcp:read", "mcp:write"] });
  binding = CredentialBinding.parse({ schema_version: 1, owner_id: owner.owner_id, created_at: "2026-01-01T00:00:00Z",
    auth_config_ref: input.auth_config_ref, application: input.application, repo_id: input.source.repo_id,
    commit_sha: input.source.commit_sha, deployment_id: input.deployment_id, url: input.url,
    resource: "https://deployment.example/", audience: "https://deployment.example/", scopes: ["mcp:read"],
    environment: input.environment, issuer: account.issuer });
  application = null;
  catalog = [selected, excluded];
  versions = [];
  vi.mocked(getApplication).mockImplementation(async () => application);
  vi.mocked(getCredentialBinding).mockImplementation(async () => binding);
  vi.mocked(getUpstreamAccount).mockImplementation(async () => account);
  vi.mocked(getVersion).mockImplementation(async (_db, _owner, _application, selector) =>
    versions.find((version) => version.version_id === selector || version.label === selector) ?? null);
  vi.mocked(insertApplication).mockImplementation(async (_db, value) => { application = value; return value; });
  vi.mocked(insertVersion).mockImplementation(async (_db, value) => { versions.push(value); return value; });
  resolveAuth.mockImplementation(async () => ({ Authorization: "Bearer test-secret-must-not-be-persisted" }));
  vi.mocked(readUpstreamCatalog).mockImplementation(async (target, settings) => {
    if (target.auth_config_ref !== null) {
      if (!settings?.resolveAuth) throw new Error("Protected discovery requires credentials");
      await settings.resolveAuth(target.auth_config_ref, target);
    }
    return catalog;
  });
});

function expectNoNetworkOrWrites() {
  expect(readUpstreamCatalog).not.toHaveBeenCalled();
  expect(resolveAuth).not.toHaveBeenCalled();
  expect(insertApplication).not.toHaveBeenCalled();
  expect(insertVersion).not.toHaveBeenCalled();
}

function expectNoAdditionalAuthority() {
  expect(callUpstream).not.toHaveBeenCalled();
  expect(putCredentialBinding).not.toHaveBeenCalled();
  expect(putUpstreamAccount).not.toHaveBeenCalled();
  expect(recordDecision).not.toHaveBeenCalled();
  expect(db.query).not.toHaveBeenCalled();
}

describe("protected remote application enrollment", () => {
  it("authenticates exact live discovery and saves only selected schemas without activation or linking", async () => {
    const result = await enrollRemoteApplication(db, owner, input, options);
    expect(getCredentialBinding).toHaveBeenCalledWith(db, owner.owner_id, input.auth_config_ref, input.url);
    expect(getUpstreamAccount).toHaveBeenCalledWith(db, owner.owner_id, input.auth_config_ref);
    expect(resolveAuth).toHaveBeenCalledWith(input.auth_config_ref, expect.objectContaining({
      owner_id: owner.owner_id, application: input.application, source: input.source, auth_config_ref: input.auth_config_ref,
      runtime_target: { kind: "mcp_streamable_http", url: input.url, deployment_id: input.deployment_id, environment: "production" },
    }));
    expect(readUpstreamCatalog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ timeoutMs: 5000 }));
    expect(vi.mocked(getCredentialBinding).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(readUpstreamCatalog).mock.invocationCallOrder[0]!);
    expect(vi.mocked(getUpstreamAccount).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(readUpstreamCatalog).mock.invocationCallOrder[0]!);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ tools: [selected], schema_digest: canonicalDigest({ tools: [selected] }),
      auth_config_ref: input.auth_config_ref, state: "ready", provenance: { subject: owner.subject, recorded_by: "owner_cli" },
      verified_provenance: { method: "owner_config", job_id: null, packet_id: null },
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } });
    expect(result).toMatchObject({ application: input.application, label: input.label, tool_count: 1, stable_changed: false });
    expect(JSON.stringify({ versions, application, result })).not.toContain("test-secret");
    expectNoAdditionalAuthority();
  });

  it.each(["owner_id", "subject"] as const)("requires trusted owner %s before reads or network", async (field) => {
    await expect(enrollRemoteApplication(db, { ...owner, [field]: "" }, input, options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(getCredentialBinding).not.toHaveBeenCalled();
    expectNoNetworkOrWrites();
  });

  it.each([
    { tools: undefined }, { tools: [] }, { tools: ["selected", "selected"] }, { tools: [""] },
    { auth_config_ref: undefined }, { auth_config_ref: null }, { auth_config_ref: "" },
    { source: { ...input.source, repo_id: "" } }, { source: { ...input.source, commit_sha: "" } },
    { deployment_id: "" }, { environment: undefined }, { environment: "local" }, { access_token: "not-accepted" },
  ])("requires a nonsecret explicit capability and deployment declaration: %j", async (changes) => {
    await expect(enrollRemoteApplication(db, owner, { ...input, ...changes }, options)).rejects.toThrow();
    expect(getCredentialBinding).not.toHaveBeenCalled();
    expectNoNetworkOrWrites();
  });

  it.each([
    "http://deployment.example/mcp", "http://127.0.0.1/mcp", "https://user:password@deployment.example/mcp",
    "https://deployment.example/mcp?token=secret", "https://deployment.example/mcp#fragment",
    "https://deployment.example/mcp?", "https://deployment.example/mcp#", "https://DEPLOYMENT.example/mcp",
    "https://deployment.example:443/mcp", "https://deployment.example/other/../mcp",
  ])("rejects unsafe or implicitly normalized URL %s before lookup or network", async (url) => {
    await expect(enrollRemoteApplication(db, owner, { ...input, url }, options)).rejects.toMatchObject({ shape: { code: "invalid_args" } });
    expect(getCredentialBinding).not.toHaveBeenCalled();
    expectNoNetworkOrWrites();
  });

  it("does not allow the builtin application", async () => {
    await expect(enrollRemoteApplication(db, owner, { ...input, application: "flywheel" }, options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expectNoNetworkOrWrites();
  });

  it("requires a credential mediator instead of allowing anonymous discovery", async () => {
    await expect(enrollRemoteApplication(db, owner, input, undefined as unknown as RemoteEnrollmentOptions))
      .rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
    expectNoNetworkOrWrites();
  });

  it.each(["binding", "account"])("rejects a missing persisted %s before credential or network activity", async (missing) => {
    if (missing === "binding") vi.mocked(getCredentialBinding).mockResolvedValue(null);
    else vi.mocked(getUpstreamAccount).mockResolvedValue(null);
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expectNoNetworkOrWrites();
  });

  it.each([
    { owner_id: "other-owner" }, { auth_config_ref: "oauth:other-app" }, { application: "other-app" },
    { repo_id: "owner/other-app" }, { commit_sha: "b".repeat(40) }, { deployment_id: "deployment-2" },
    { environment: "preview" }, { url: "https://other.example/mcp" }, { issuer: "https://other-issuer.example/" },
    { scopes: ["mcp:admin"] },
  ] satisfies Partial<CredentialBinding>[])("checks every persisted binding identity before network: %j", async (changes) => {
    binding = { ...binding, ...changes };
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expectNoNetworkOrWrites();
  });

  it.each([
    { owner_id: "other-owner" }, { auth_config_ref: "oauth:other-app" }, { application: "other-app" },
    { repo_id: "owner/other-app" }, { environment: "preview" }, { issuer: "https://other-issuer.example/" }, { scopes: ["mcp:write"] },
  ] satisfies Partial<UpstreamAccount>[])("checks every linked-account identity before network: %j", async (changes) => {
    account = { ...account, ...changes };
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expectNoNetworkOrWrites();
  });

  it("does not downgrade to anonymous discovery when credential resolution fails", async () => {
    resolveAuth.mockRejectedValue(new FlywheelError("forbidden", "Credential verification failed."));
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(readUpstreamCatalog).toHaveBeenCalledTimes(1);
    expect(resolveAuth).toHaveBeenCalledTimes(1);
    expect(insertApplication).not.toHaveBeenCalled();
    expect(insertVersion).not.toHaveBeenCalled();
    expectNoAdditionalAuthority();
  });

  it("never persists a ready registration after discovery fails", async () => {
    vi.mocked(readUpstreamCatalog).mockRejectedValue(new FlywheelError("upstream_error", "Upstream discovery failed."));
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "upstream_error" } });
    expect(insertApplication).not.toHaveBeenCalled();
    expect(insertVersion).not.toHaveBeenCalled();
  });

  it("rejects a missing selected capability without creating records", async () => {
    await expect(enrollRemoteApplication(db, owner, { ...input, tools: ["absent"] }, options))
      .rejects.toMatchObject({ shape: { code: "invalid_args" } });
    expect(insertApplication).not.toHaveBeenCalled();
    expect(insertVersion).not.toHaveBeenCalled();
  });

  it("rejects an unsupported selected schema but permits the same schema when unselected", async () => {
    await expect(enrollRemoteApplication(db, owner, { ...input, tools: ["excluded"] }, options))
      .rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expect(insertVersion).not.toHaveBeenCalled();
    await expect(enrollRemoteApplication(db, owner, input, options)).resolves.toMatchObject({ tool_count: 1 });
  });

  it.each([{ tools: [] }, { tools: [selected, selected] }])("rejects empty or duplicate catalogs", async ({ tools }) => {
    catalog = tools;
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expect(insertApplication).not.toHaveBeenCalled();
    expect(insertVersion).not.toHaveBeenCalled();
  });

  it("reconciles identical enrollment while preserving immutable label conflicts", async () => {
    const result = await enrollRemoteApplication(db, owner, input, options);
    expect(await enrollRemoteApplication(db, owner, input, options)).toEqual(result);
    expect(insertApplication).toHaveBeenCalledTimes(1);
    expect(insertVersion).toHaveBeenCalledTimes(1);
    catalog = [{ ...selected, description: "Different catalog content" }];
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
    expect(insertVersion).toHaveBeenCalledTimes(1);
    expectNoAdditionalAuthority();
  });

  it("rejects an application metadata conflict before discovery", async () => {
    application = Application.parse({ schema_version: 1, owner_id: owner.owner_id, created_at: "2026-01-01T00:00:00Z",
      provenance: provenanceOf("owner_cli", null), completeness: COMPLETE, application: input.application,
      description: "Different application", kind: "upstream" });
    await expect(enrollRemoteApplication(db, owner, input, options)).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
    expectNoNetworkOrWrites();
  });

  it("requires an exact existing parent in the same repository before discovery", async () => {
    const parent_version_id = `ver_${"a".repeat(26)}`;
    await expect(enrollRemoteApplication(db, owner, { ...input, parent_version_id }, options))
      .rejects.toMatchObject({ shape: { code: "version_unavailable" } });
    expectNoNetworkOrWrites();
  });
});

describe("local enrollment compatibility", () => {
  const local = { application: input.application, description: input.description, label: input.label, source: input.source,
    url: "http://127.0.0.1:8790/mcp", deployment_id: "local-test" };

  it("keeps anonymous local discovery and optional full-catalog selection", async () => {
    catalog = [selected, { ...selected, name: "another" }];
    const result = await enrollLocalApplication(db, owner, local);
    expect(result).toMatchObject({ tool_count: 2, stable_changed: false });
    expect(versions[0]).toMatchObject({ auth_config_ref: null, runtime_target: {
      kind: "mcp_streamable_http", url: local.url, deployment_id: local.deployment_id, environment: "local",
    } });
    expect(getCredentialBinding).not.toHaveBeenCalled();
    expect(getUpstreamAccount).not.toHaveBeenCalled();
    expect(resolveAuth).not.toHaveBeenCalled();
    expectNoAdditionalAuthority();
  });

  it("keeps explicit local subset validation", async () => {
    await expect(enrollLocalApplication(db, owner, { ...local, tools: ["selected"] })).resolves.toMatchObject({ tool_count: 1 });
    expect(versions[0]?.tools).toEqual([selected]);
  });

  it.each(["https://deployment.example/mcp", "http://localhost:8790/mcp", "http://127.0.0.1:8790/mcp?token=secret"])
    ("keeps literal credential-free loopback restrictions: %s", async (url) => {
      await expect(enrollLocalApplication(db, owner, { ...local, url })).rejects.toMatchObject({ shape: { code: "invalid_args" } });
      expectNoNetworkOrWrites();
    });
});
