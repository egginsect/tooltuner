import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, getUpstreamAccount, getCredentialBinding } from "../../src/db/registry.js";
import { createCredentialMediator, createCredentialHelperStore, createEnvironmentCredentialStore, OAuthCredential, type CredentialStore } from "../../src/gateway/credentials.js";
import { createProtectedPreviewVerifier, type ProtectedPreviewTarget } from "../../src/gateway/preview.js";
import { beginUpstreamAccountLink, linkUpstreamAccount, type LinkOptions } from "../../src/cli/link.js";
import { startProtectedFixture } from "../../fixtures/protected.js";
import type { UpstreamTarget } from "../../src/gateway/upstream.js";

let db: GraphClient;
let fixture: Awaited<ReturnType<typeof startProtectedFixture>>;
let directory: string;
let helper: CredentialStore;
const reference = "fixture:linked-account";
const secretRef = "helper:local-account";
const source = { repo_id: "fixture-repo", commit_sha: "a".repeat(40) };

function linkOptions(store = helper, credentialRef = secretRef): LinkOptions {
  return { db, owner: { owner_id: "owner", subject: "local-owner" }, store,
    account: { auth_config_ref: reference, credential_ref: credentialRef, application: "textkit", repo_id: source.repo_id, environment: "local",
      issuer: fixture.issuer, introspection_url: `${fixture.origin}/introspect`, scopes: ["fixture:read"] },
    target: { commit_sha: source.commit_sha, deployment_id: "deployment-a", url: `${fixture.origin}/deployment-a/mcp`,
      resource: `${fixture.origin}/deployment-a/mcp`, audience: `${fixture.origin}/deployment-a/mcp` } };
}
function pinned(deployment = "deployment-a", sha = source.commit_sha): UpstreamTarget {
  return { owner_id: "owner", application: "textkit", version_id: "ver_00000000000000000000000001", source: { ...source, commit_sha: sha },
    runtime_target: { kind: "mcp_streamable_http", url: `${fixture.origin}/${deployment}/mcp`, deployment_id: deployment, environment: "local" }, auth_config_ref: reference };
}
function previewTarget(): ProtectedPreviewTarget {
  return { ownerId: "owner", application: "textkit", repoId: source.repo_id, commitSha: "b".repeat(40),
    deploymentId: "deployment-b", url: `${fixture.origin}/deployment-b/mcp`, projectId: "test-project", teamId: "test-team" };
}
function verifier(credentials = createCredentialMediator({ db, store: helper })) {
  return createProtectedPreviewVerifier({ credentials, projects: [{ ownerId: "owner", application: "textkit", repoId: source.repo_id,
    projectId: "test-project", teamId: "test-team", authConfigRef: reference, issuer: fixture.issuer, scopes: ["fixture:read"],
    mcpPath: "/deployment-b/mcp", localOrigin: fixture.origin }] });
}
async function linked() {
  await helper.put!(secretRef, fixture.credential());
  return linkUpstreamAccount(linkOptions());
}

beforeEach(async () => {
  db = await GraphClient.connect({ url: process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379", graph: `gateway_credentials_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, REGISTRY_INDEX_SPECS);
  fixture = await startProtectedFixture();
  directory = await mkdtemp(path.join(tmpdir(), "flywheel-credential-test-"));
  helper = createCredentialHelperStore({ executable: fileURLToPath(new URL("../../fixtures/credential-helper.mjs", import.meta.url)), homeDirectory: directory });
});
afterEach(async () => {
  try { await fixture?.close(); }
  finally {
    try { if (db) { try { await db.dropGraph(); } finally { await db.close(); } } }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
});

it("links once through real SDK DCR/PKCE/consent/token exchange and reuses the account across version pins", async () => {
  const result = await beginUpstreamAccountLink({ ...linkOptions(), onAuthorizationUrl: (url) => fixture.approve(url) });
  expect(result.account.auth_config_ref).toBe(reference);
  expect(fixture.metrics.registrations).toBe(1);
  expect(fixture.metrics.consent).toBe(1);
  const secret = OAuthCredential.parse(await helper.get(secretRef));
  expect(Boolean(secret.tokens.access_token && secret.tokens.refresh_token)).toBe(true);
  const docs = await db.roQuery<{ doc: string }>("MATCH (n) WHERE n.doc IS NOT NULL RETURN n.doc AS doc");
  expect(docs.every((row) => !row.doc.includes(secret.tokens.access_token) && !row.doc.includes(secret.tokens.refresh_token!))).toBe(true);
  expect(await getUpstreamAccount(db, "other-owner", reference)).toBeNull();
  const reconnect = await GraphClient.connect({ url: process.env["FALKORDB_URL"] || "redis://127.0.0.1:6379", graph: db.graphName });
  try {
    const mediator = createCredentialMediator({ db: reconnect, store: helper });
    for (const version_id of ["ver_00000000000000000000000001", "ver_00000000000000000000000002"]) {
      const headers = await mediator.resolveAuth(reference, { ...pinned(), version_id });
      const client = new Client({ name: "account-reuse-test", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(pinned().runtime_target.url), { requestInit: { headers, redirect: "error" } }));
        expect((await client.callTool({ name: "echo", arguments: { text: "repeatable" } })).structuredContent).toEqual({ text: "repeatable" });
      } finally { await client.close(); }
    }
  } finally { await reconnect.close(); }
  expect(fixture.metrics.registrations).toBe(1);
  expect(fixture.metrics.consent).toBe(1);
  expect(fixture.metrics.toolCalls).toBe(2);
  await expect(beginUpstreamAccountLink({ ...linkOptions(), onAuthorizationUrl: () => undefined })).rejects.toMatchObject({ shape: { code: "ingest_conflict" } });
  expect(fixture.metrics.registrations).toBe(1);
  expect(OAuthCredential.parse(await helper.get(secretRef)).tokens.access_token === secret.tokens.access_token).toBe(true);
});

it("links an explicit environment reference without login and enforces exact owner/app/repo/source/deployment bindings", async () => {
  const secret = fixture.credential();
  const environment = createEnvironmentCredentialStore({ TEST_ACCOUNT: JSON.stringify(secret) });
  await linkUpstreamAccount(linkOptions(environment, "env:TEST_ACCOUNT"));
  const mediator = createCredentialMediator({ db, store: environment });
  expect(Object.keys(await mediator.resolveAuth(reference, pinned()))).toEqual(["Authorization"]);
  for (const target of [
    { ...pinned(), owner_id: "other-owner" }, { ...pinned(), application: "catalog" },
    { ...pinned(), source: { ...source, repo_id: "other-repo" } }, { ...pinned(), source: { ...source, commit_sha: "b".repeat(40) } },
    { ...pinned(), runtime_target: { ...pinned().runtime_target, deployment_id: "other-deployment" } },
    { ...pinned(), runtime_target: { ...pinned().runtime_target, environment: "production" as const } }, pinned("deployment-b"),
  ]) await expect(mediator.resolveAuth(reference, target)).rejects.toMatchObject({ shape: { code: "forbidden" } });
  expect(fixture.metrics.toolCalls).toBe(0);
});

it("proves negative audience/resource rejection and real authenticated SDK initialize/tools/schema before approving a new deployment", async () => {
  await linked();
  const credentials = createCredentialMediator({ db, store: helper });
  const initial = OAuthCredential.parse(await helper.get(secretRef));
  const result = await verifier(credentials).verifyRuntime(previewTarget());
  expect(result).toMatchObject({ initializeVerified: true, authVerified: true, resourceVerified: true, auth_config_ref: reference });
  expect(result.tools.map((tool) => tool.name)).toEqual(["echo"]);
  expect(fixture.metrics.refreshes).toBe(2);
  expect(fixture.metrics.rejectedAudience).toBeGreaterThan(0);
  expect(fixture.metrics.toolCalls).toBe(0);
  const stored = await getCredentialBinding(db, "owner", reference, previewTarget().url);
  expect(stored).toMatchObject({ deployment_id: "deployment-b", commit_sha: "b".repeat(40), resource: previewTarget().url, audience: previewTarget().url });
  const rotated = OAuthCredential.parse(await helper.get(secretRef));
  expect(initial.tokens.refresh_token !== rotated.tokens.refresh_token).toBe(true);
  const headers = await credentials.resolveAuth(reference, pinned("deployment-b", "b".repeat(40)));
  const client = new Client({ name: "verified-preview-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(previewTarget().url), { requestInit: { headers, redirect: "error" } }));
    expect((await client.callTool({ name: "echo", arguments: { text: "verified" } })).structuredContent).toEqual({ text: "verified" });
  } finally { await client.close(); }
  expect(fixture.metrics.registrations).toBe(0);
  expect(fixture.metrics.consent).toBe(0);
});

it.each(["publicRuntime", "ignoreAudience", "wrongMetadata", "redirectRuntime", "missingScope"] as const)(
  "does not approve a protected preview with %s", async (fault) => {
    await linked(); fixture.faults[fault] = true;
    await expect(verifier().verifyRuntime(previewTarget())).rejects.toBeDefined();
    expect(await getCredentialBinding(db, "owner", reference, previewTarget().url)).toBeNull();
  },
);

it("rejects overbroad/mismatched audience tokens, production credentials and unsafe issuer/resource redirects before linking", async () => {
  const raw = fixture.credential();
  for (const secret of [{ ...raw, environment: "production" }, raw]) {
    fixture.faults.wrongIntrospectionAudience = secret.environment !== "production";
    const store = createEnvironmentCredentialStore({ BAD_ACCOUNT: JSON.stringify(secret) });
    await expect(linkUpstreamAccount(linkOptions(store, "env:BAD_ACCOUNT"))).rejects.toBeDefined();
    expect(await getUpstreamAccount(db, "owner", reference)).toBeNull();
  }
  fixture.faults.wrongIntrospectionAudience = false;
  const unsafe = linkOptions(createEnvironmentCredentialStore({ BAD_ACCOUNT: JSON.stringify(raw) }), "env:BAD_ACCOUNT");
  unsafe.account.introspection_url = "http://127.0.0.1:1/introspect";
  await expect(linkUpstreamAccount(unsafe)).rejects.toBeDefined();
  expect(await getUpstreamAccount(db, "owner", reference)).toBeNull();
});

it("rejects wrong callback state and missing secure persistence without linking an account", async () => {
  await expect(beginUpstreamAccountLink({ ...linkOptions(), timeoutMs: 600, onAuthorizationUrl: (url) => fixture.approve(url, { corruptState: true }) })).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
  expect(await getUpstreamAccount(db, "owner", reference)).toBeNull();
  const readOnly = createEnvironmentCredentialStore({});
  await expect(beginUpstreamAccountLink({ ...linkOptions(readOnly), onAuthorizationUrl: () => undefined })).rejects.toMatchObject({ shape: { code: "operation_unavailable" } });
});

it("rejects changed schema and unconfigured deployment authority without acknowledging readiness", async () => {
  await linked();
  const result = await verifier().verifyRuntime(previewTarget());
  fixture.faults.changedSchema = true;
  await expect(verifier().verifyRuntime({ ...previewTarget(), schemaDigest: result.schema_digest })).rejects.toMatchObject({ shape: { code: "version_unavailable" } });
  await expect(verifier().verifyRuntime({ ...previewTarget(), projectId: "unapproved-project" })).rejects.toMatchObject({ shape: { code: "forbidden" } });
});
