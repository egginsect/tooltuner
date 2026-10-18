import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS, insertApplication, insertVersion, versionDigest } from "../../src/db/registry.js";
import { insertGrant } from "../../src/db/auth.js";
import { Application, Version, Grant, COMPLETE, provenanceOf, canonicalDigest, newId } from "../../src/contracts.js";
import { createPostgresCredentialStore } from "../../src/gateway/postgres-credentials.js";
import { beginUpstreamAccountLink } from "../../src/cli/link.js";
import { OAuthCredential } from "../../src/gateway/credentials.js";
import { createRuntime } from "../../src/runtime.js";
import { loadConfig } from "../../src/config.js";
import { readUpstreamCatalog } from "../../src/gateway/upstream.js";
import { startProtectedFixture } from "../../fixtures/protected.js";

test("encrypted browser link, owner CLI, rotating refresh and runtime dispatch preserve graph evidence isolation", async () => {
  const connectionString = process.env.TEST_CREDENTIAL_POSTGRES_URL;
  if (!connectionString) throw new Error("Disposable TEST_CREDENTIAL_POSTGRES_URL required");
  const key = randomBytes(32);
  const store = createPostgresCredentialStore({ connectionString, keys: { test: key }, activeKeyVersion: "test", tls: false });
  const graph = `pg_custody_${randomUUID().replaceAll("-", "")}`;
  const graphUrl = process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379";
  const db = await GraphClient.connect({ url: graphUrl, graph });
  const fixture = await startProtectedFixture();
  const directory = await mkdtemp(path.join(tmpdir(), "flywheel-pg-test-"));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    await store.initialize(); await bootstrapSchema(db, REGISTRY_INDEX_SPECS);
    const configuration = { kind: "postgres", activeKeyVersion: "test", tls: false };
    const account = { auth_config_ref: "test:postgres", credential_ref: `postgres:${randomUUID()}`, application: "textkit", repo_id: "test/repo", environment: "local" as const,
      issuer: fixture.issuer, introspection_url: `${fixture.origin}/introspect`, scopes: ["fixture:read"] };
    const resource = `${fixture.origin}/deployment-a/mcp`;
    const target = { commit_sha: "a".repeat(40), deployment_id: "deployment-a", url: resource, resource, audience: resource };
    const linked = await beginUpstreamAccountLink({ db, store, owner: { owner_id: "owner", subject: "synthetic-owner" }, account, target,
      onAuthorizationUrl: (url) => fixture.approve(url) });
    const before = OAuthCredential.parse(await store.get(account.credential_ref, linked.binding));
    const environment = { PATH: process.env.PATH, FALKORDB_URL: graphUrl, FALKORDB_GRAPH: graph,
      FLYWHEEL_CREDENTIAL_POSTGRES_URL: connectionString, FLYWHEEL_CREDENTIAL_KEYS: JSON.stringify({ test: key.toString("base64") }) };
    const linkFile = path.join(directory, "link.json"); const runtimeFile = path.join(directory, "runtime.json");
    await writeFile(linkFile, JSON.stringify({ credentialStore: configuration, account, target }));
    const cli = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/owner.ts", "account", "link", "--input", linkFile,
      "--subject", "synthetic-owner", "--mode", "existing"], { env: environment, timeout: 15000 });
    expect(JSON.parse(cli.stdout).linked).toBe(true);
    expect(cli.stdout + cli.stderr).not.toContain(before.tokens.access_token);
    // Expire this test-only document through a legitimate read/CAS write, then let runtime refresh it.
    await store.exclusive!(account.credential_ref, linked.binding, async (locked) => {
      const value = OAuthCredential.parse(await locked.get(account.credential_ref));
      await locked.put!(account.credential_ref, { ...value, obtained_at: 0, tokens: { ...value.tokens, expires_in: 1 } });
    });
    await writeFile(runtimeFile, JSON.stringify({ credentialStore: configuration }));
    runtime = await createRuntime({ config: loadConfig({ RUNNER_CONFIG_PATH: runtimeFile }), db, environment });
    const metadata = { schema_version: 1 as const, owner_id: "owner", created_at: new Date().toISOString(), provenance: provenanceOf("seed", null), completeness: COMPLETE };
    await insertApplication(db, Application.parse({ ...metadata, application: "textkit", description: "Encrypted custody fixture", kind: "upstream" }));
    const pinned = { owner_id: "owner", application: "textkit", version_id: newId("version"), source: { repo_id: account.repo_id, commit_sha: target.commit_sha },
      runtime_target: { kind: "mcp_streamable_http" as const, url: resource, deployment_id: target.deployment_id, environment: "local" as const }, auth_config_ref: account.auth_config_ref };
    const tools = await readUpstreamCatalog(pinned, { resolveAuth: async () => ({ Authorization: `Bearer ${before.tokens.access_token}` }) });
    const content = Version.parse({ ...metadata, ...pinned, label: "v1", parent_version_id: null, tools, schema_digest: canonicalDigest({ tools }), digest: canonicalDigest({}),
      verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, state: "ready",
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } });
    const version = await insertVersion(db, { ...content, digest: versionDigest(content) });
    const grant = Grant.parse({ schema_version: 1, owner_id: "owner", grant_id: newId("grant"), label: "synthetic", groups: ["user"],
      allow: { apps: ["textkit"], tools: {}, repos: [account.repo_id] }, created_at: new Date().toISOString() });
    await insertGrant(db, grant);
    const response = await runtime.core.dispatch({ grant, principal: { owner_id: "owner", grant_id: grant.grant_id, subject: "test", client_id: "test", session_id: "test" } },
      { application: "textkit", version: version.version_id, tool: tools[0]!.name, args: { text: "encrypted custody call" } });
    expect(response.outcome).toBe("success"); expect(fixture.metrics.refreshes).toBe(1);
    const after = OAuthCredential.parse(await store.get(account.credential_ref, linked.binding));
    expect(after.tokens.access_token).not.toBe(before.tokens.access_token);
    const docs = JSON.stringify(await db.roQuery("MATCH (n) WHERE n.doc IS NOT NULL RETURN n.doc AS doc"));
    for (const value of [before.tokens.access_token, before.tokens.refresh_token!, after.tokens.access_token, after.tokens.refresh_token!, key.toString("base64")]) expect(docs + cli.stdout + cli.stderr).not.toContain(value);
  } finally {
    await runtime?.closeCredentials(); await store.close(); await fixture.close();
    try { await db.dropGraph(); } finally { await db.close(); await rm(directory, { recursive: true }); }
  }
}, 30000);
