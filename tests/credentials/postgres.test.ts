import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { Pool } from "pg";
import { createPostgresCredentialStore } from "../../src/gateway/postgres-credentials.js";
import type { CredentialBinding } from "../../src/db/registry.js";

const connectionString = process.env.TEST_CREDENTIAL_POSTGRES_URL;
if (!connectionString) throw new Error("Set TEST_CREDENTIAL_POSTGRES_URL to a disposable loopback PostgreSQL database; this suite creates its credential table.");
const keys = { v1: randomBytes(32), v2: randomBytes(32) };
const make = (activeKeyVersion = "v1", keyring = keys) => createPostgresCredentialStore({ connectionString, keys: keyring, activeKeyVersion, tls: false });
const store = make();
const other = make();
const db = new Pool({ connectionString });
const binding: CredentialBinding = { schema_version: 1, owner_id: "test-owner", created_at: new Date().toISOString(),
  auth_config_ref: "test-auth", application: "textkit", repo_id: "test/repo", commit_sha: "a".repeat(40), deployment_id: "deployment-a",
  url: "http://127.0.0.1:3111/mcp", resource: "http://127.0.0.1:3111/mcp", audience: "synthetic-audience", scopes: ["mcp"], environment: "local", issuer: "http://127.0.0.1:3111" };
const secret = { issuer: binding.issuer, environment: binding.environment, resource: binding.resource, audience: binding.audience,
  obtained_at: 1, client: { client_id: "synthetic-client", client_secret: "synthetic-client-secret" },
  tokens: { access_token: "synthetic-access-secret", refresh_token: "synthetic-refresh-secret", token_type: "Bearer" } };
const reference = () => `postgres:test-${randomUUID()}`;
beforeAll(() => store.initialize());
afterAll(async () => { await store.close(); await other.close(); await db.end(); });

test("roundtrips with ciphertext-only rows and authenticates each exact binding field", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  expect(await store.get(ref, binding)).toEqual(secret);
  const row = (await db.query("SELECT * FROM flywheel_upstream_credentials WHERE reference=$1", [ref])).rows[0];
  const bytes = JSON.stringify(row);
  for (const value of [secret.tokens.access_token, secret.tokens.refresh_token, secret.client.client_secret, keys.v1.toString("base64")]) expect(bytes).not.toContain(value);
  for (const [field, value] of Object.entries({ owner_id: "other", application: "other", repo_id: "other/repo", issuer: "http://localhost:3111", resource: "http://localhost:3111/mcp", audience: "other", commit_sha: "b".repeat(40), deployment_id: "other", environment: "preview", auth_config_ref: "other", url: "http://localhost:3111/mcp", scopes: ["other"] })) {
    await expect(store.get(ref, { ...binding, [field]: value })).rejects.toThrow("Encrypted credential custody failed");
  }
  await expect(store.get(ref)).rejects.toThrow();
  await expect(store.put!(ref, secret, binding)).rejects.toThrow(); // no blind overwrite/relink
  await db.query("UPDATE flywheel_upstream_credentials SET tag=$2 WHERE reference=$1", [ref, randomBytes(16)]);
  await expect(store.get(ref, binding)).rejects.toThrow("Encrypted credential custody failed");
});

test("historical key reads and write-time rotation; unknown or wrong keys fail closed", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  const rotated = make("v2"); const missing = make("v2", { v2: keys.v2 } as typeof keys);
  const wrong = make("v1", { ...keys, v1: randomBytes(32) });
  try {
    await expect(missing.get(ref, binding)).rejects.toThrow(); await expect(wrong.get(ref, binding)).rejects.toThrow();
    await rotated.exclusive!(ref, binding, async (locked) => { const value = await locked.get(ref); await locked.put!(ref, value); });
    expect(await missing.get(ref, binding)).toEqual(secret);
    expect((await db.query("SELECT key_version,token_version FROM flywheel_upstream_credentials WHERE reference=$1", [ref])).rows[0]).toEqual({ key_version: "v2", token_version: 2 });
  } finally { await rotated.close(); await missing.close(); await wrong.close(); }
});

test("independent store sessions fence refresh and reject stale CAS without overwriting", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  await store.exclusive!(ref, binding, async (locked) => {
    await locked.get(ref); await locked.beginRefresh!();
    await expect(other.get(ref, binding)).rejects.toThrow();
    const child = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { createPostgresCredentialStore } from './src/gateway/postgres-credentials.ts';
      const store = createPostgresCredentialStore({ connectionString: process.env.TEST_URL,
        keys: { v1: Buffer.from(process.env.TEST_KEY, 'base64') }, activeKeyVersion: 'v1', tls: false });
      try { await store.get(process.env.TEST_REF, JSON.parse(process.env.TEST_BINDING)); process.exitCode = 2; }
      catch { process.stdout.write('blocked'); } finally { await store.close(); }
    `], { env: { PATH: process.env.PATH, TEST_URL: connectionString, TEST_KEY: keys.v1.toString("base64"), TEST_REF: ref, TEST_BINDING: JSON.stringify(binding) }, timeout: 5000 });
    expect(child.stdout).toBe("blocked");
    await locked.put!(ref, { ...secret, tokens: { ...secret.tokens, access_token: "synthetic-new-access" } });
  });
  expect((await other.get(ref, binding) as typeof secret).tokens.access_token).toBe("synthetic-new-access");
  await expect(store.exclusive!(ref, binding, async (locked) => {
    await locked.get(ref);
    await db.query("UPDATE flywheel_upstream_credentials SET token_version=token_version+1 WHERE reference=$1", [ref]);
    await locked.put!(ref, secret);
  })).rejects.toThrow();
  expect((await other.get(ref, binding) as typeof secret).tokens.access_token).toBe("synthetic-new-access");
});

test("interrupted remote refresh remains fenced after releasing the connection", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  await expect(store.exclusive!(ref, binding, async (locked) => { await locked.get(ref); await locked.beginRefresh!(); throw new Error(secret.tokens.refresh_token); })).rejects.toThrow("Encrypted credential custody failed");
  await expect(other.get(ref, binding)).rejects.toThrow("Encrypted credential custody failed");
  await expect(other.put!(ref, secret, binding)).rejects.toThrow();
  expect((await db.query("SELECT refreshing,token_version FROM flywheel_upstream_credentials WHERE reference=$1", [ref])).rows[0]).toEqual({ refreshing: true, token_version: 1 });
});

test("a lost database session during remote refresh cannot crash or acknowledge success", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  await expect(store.exclusive!(ref, binding, async (locked) => {
    await locked.get(ref); await locked.beginRefresh!();
    // Restrict termination to this test reference in this database, never other cluster sessions.
    await db.query(`SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid AND objid=(hashtextextended($1,0) & 4294967295)::oid AND objsubid=1 AND pid <> pg_backend_pid()`, [ref]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return "must not acknowledge";
  })).rejects.toThrow("Encrypted credential custody failed");
  await expect(other.get(ref, binding)).rejects.toThrow();
});
