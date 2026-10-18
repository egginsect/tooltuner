import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { Pool } from "pg";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema } from "../../src/db/schema.js";
import { REGISTRY_INDEX_SPECS } from "../../src/db/registry.js";
import { createPostgresCredentialStore } from "../../src/gateway/postgres-credentials.js";
import { createCredentialMediator, OAuthCredential } from "../../src/gateway/credentials.js";
import { beginUpstreamAccountLink, linkUpstreamAccount, type LinkOptions } from "../../src/cli/link.js";
import { startProtectedFixture } from "../../fixtures/protected.js";

const connectionString = process.env.TEST_CREDENTIAL_POSTGRES_URL;
if (!connectionString) throw new Error("Set TEST_CREDENTIAL_POSTGRES_URL to a disposable PostgreSQL database.");

test("standard OAuth uses fresh PKCE, missing optional PRM scopes, encrypted provenance, resource acceptance and fenced rotation without introspection", async () => {
  const fixture = await startProtectedFixture();
  fixture.faults.omitResourceScopes = true; fixture.faults.disableIntrospection = true;
  const key = randomBytes(32);
  const store = createPostgresCredentialStore({ connectionString, keys: { test: key }, activeKeyVersion: "test", tls: false });
  const sql = new Pool({ connectionString });
  const db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph: `standard_${randomUUID().replaceAll("-", "")}` });
  const resource = `${fixture.origin}/deployment-a/mcp`;
  const options: LinkOptions = { db, owner: { owner_id: "owner", subject: "synthetic-owner" }, store,
    account: { validation_mode: "standard_oauth", auth_config_ref: "test:standard", credential_ref: `postgres:${randomUUID()}`,
      application: "textkit", repo_id: "test/repo", environment: "local", issuer: fixture.issuer, scopes: ["fixture:read"] },
    target: { commit_sha: "a".repeat(40), deployment_id: "deployment-a", url: resource, resource, audience: resource } };
  try {
    await bootstrapSchema(db, REGISTRY_INDEX_SPECS); await store.initialize();
    await expect(linkUpstreamAccount(options)).rejects.toThrow("cannot import");
    const linked = await beginUpstreamAccountLink({ ...options, onAuthorizationUrl: (url) => fixture.approve(url) });
    expect(linked.account.validation_mode).toBe("standard_oauth");
    const first = OAuthCredential.parse(await store.get(options.account.credential_ref, linked.binding));
    expect(first.acquisition?.method).toBe("authorization_code_s256");
    expect(fixture.metrics.toolCalls).toBe(0);
    const mediator = createCredentialMediator({ db, store });
    const target = { owner_id: "owner", application: "textkit", source: { repo_id: "test/repo", commit_sha: "a".repeat(40) }, version_id: "ver_00000000000000000000000001",
      runtime_target: { kind: "mcp_streamable_http" as const, url: resource, deployment_id: "deployment-a", environment: "local" as const }, auth_config_ref: "test:standard" };
    await mediator.resolveAuth("test:standard", target);
    await expect(mediator.resolveAuth("test:standard", { ...target, source: { ...target.source, commit_sha: "b".repeat(40) } })).rejects.toThrow();
    // A near-expiry credential triggers a real resource-bound refresh while preserving acquisition identity.
    await store.exclusive!(options.account.credential_ref, linked.binding, async (locked) => {
      const value = OAuthCredential.parse(await locked.get(options.account.credential_ref));
      await locked.put!(options.account.credential_ref, { ...value, tokens: { ...value.tokens, expires_in: 1 } });
    });
    await mediator.resolveAuth("test:standard", target);
    const rotated = OAuthCredential.parse(await store.get(options.account.credential_ref, linked.binding));
    expect(fixture.metrics.refreshes).toBe(1); expect(rotated.tokens.refresh_token).not.toBe(first.tokens.refresh_token);
    expect(rotated.acquisition).toEqual(first.acquisition);
    const row = JSON.stringify((await sql.query("SELECT * FROM flywheel_upstream_credentials WHERE reference=$1", [options.account.credential_ref])).rows);
    const graph = JSON.stringify(await db.roQuery("MATCH (n) WHERE n.doc IS NOT NULL RETURN n.doc AS doc"));
    for (const secret of [first.tokens.access_token, first.tokens.refresh_token!, rotated.tokens.access_token, rotated.tokens.refresh_token!, key.toString("base64")]) expect(row + graph).not.toContain(secret);
    fixture.faults.redirectRuntime = true;
    await expect(mediator.resolveAuth("test:standard", target)).rejects.toThrow();
    fixture.faults.redirectRuntime = false;
    // Wrong-resource opaque tokens are rejected by the resource server, never by decoded claims.
    await store.exclusive!(options.account.credential_ref, linked.binding, async (locked) => {
      const value = OAuthCredential.parse(await locked.get(options.account.credential_ref));
      await locked.put!(options.account.credential_ref, { ...value, tokens: { ...value.tokens, access_token: fixture.credential(`${fixture.origin}/deployment-b/mcp`).tokens.access_token } });
    });
    await expect(mediator.resolveAuth("test:standard", target)).rejects.toThrow();
    expect(fixture.metrics.rejectedAudience).toBeGreaterThan(0);
  } finally {
    await sql.query("DELETE FROM flywheel_upstream_credentials WHERE reference=$1", [options.account.credential_ref]);
    await sql.end(); await store.close(); await fixture.close();
    try { await db.dropGraph(); } finally { await db.close(); }
  }
}, 30000);
