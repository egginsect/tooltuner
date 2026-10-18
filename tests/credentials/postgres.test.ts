import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { Client, Pool } from "pg";
import { CREDENTIAL_SCHEMA, createPostgresCredentialStore } from "../../src/gateway/postgres-credentials.js";
import type { CredentialBinding } from "../../src/db/registry.js";

const connectionString = process.env.TEST_CREDENTIAL_POSTGRES_URL;
if (!connectionString) throw new Error("Set TEST_CREDENTIAL_POSTGRES_URL to a disposable loopback PostgreSQL database; this suite creates its credential table.");
const runtimeConnectionString = process.env.TEST_CREDENTIAL_POSTGRES_RUNTIME_URL ?? connectionString;
const keys = { v1: randomBytes(32), v2: randomBytes(32) };
const make = (activeKeyVersion = "v1", keyring = keys) => createPostgresCredentialStore({ connectionString: runtimeConnectionString, keys: keyring, activeKeyVersion, tls: false, requireRls: process.env.TEST_CREDENTIAL_REQUIRE_RLS === "1" });
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
beforeAll(() => db.query(CREDENTIAL_SCHEMA));
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
      import { CREDENTIAL_SCHEMA, createPostgresCredentialStore } from './src/gateway/postgres-credentials.ts';
      const store = createPostgresCredentialStore({ connectionString: process.env.TEST_URL,
        keys: { v1: Buffer.from(process.env.TEST_KEY, 'base64') }, activeKeyVersion: 'v1', tls: false, requireRls: process.env.TEST_CREDENTIAL_REQUIRE_RLS === '1' });
      try { await store.get(process.env.TEST_REF, JSON.parse(process.env.TEST_BINDING)); process.exitCode = 2; }
      catch { process.stdout.write('blocked'); } finally { await store.close(); }
    `], { env: { PATH: process.env.PATH, TEST_URL: runtimeConnectionString, TEST_CREDENTIAL_REQUIRE_RLS: process.env.TEST_CREDENTIAL_REQUIRE_RLS, TEST_KEY: keys.v1.toString("base64"), TEST_REF: ref, TEST_BINDING: JSON.stringify(binding) }, timeout: 5000 });
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
  expect((await db.query("SELECT refreshing,token_version FROM flywheel_upstream_credentials WHERE reference=$1", [ref])).rows[0]).toEqual({ refreshing: true, token_version: 2 });
});

test("pre-request interruption is retryable but a claimed version is never replayed", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  await expect(store.exclusive!(ref, binding, async (scoped) => {
    await scoped.get(ref); throw new Error("discovery failed before claim");
  })).rejects.toThrow();
  expect(await other.get(ref, binding)).toEqual(secret);
  let requests = 0;
  await expect(store.exclusive!(ref, binding, async (scoped) => {
    await scoped.get(ref); await scoped.beginRefresh!(); requests++;
    throw new Error("request timed out with unknown outcome");
  })).rejects.toThrow();
  await expect(other.exclusive!(ref, binding, async (scoped) => {
    await scoped.get(ref); await scoped.beginRefresh!(); requests++;
  })).rejects.toThrow();
  expect(requests).toBe(1);
});

test("stale writers and refresh claimants cannot clear or reuse another claim", async () => {
  const ref = reference(); await store.put!(ref, secret, binding);
  await store.exclusive!(ref, binding, async (stale) => {
    await stale.get(ref);
    await other.exclusive!(ref, binding, async (winner) => {
      await winner.get(ref); await winner.beginRefresh!();
      await expect(stale.put!(ref, secret)).rejects.toThrow();
      await expect(stale.beginRefresh!()).rejects.toThrow();
      await expect(winner.beginRefresh!()).rejects.toThrow();
      expect((await db.query("SELECT refreshing,token_version FROM flywheel_upstream_credentials WHERE reference=$1", [ref])).rows[0]).toEqual({ refreshing: true, token_version: 2 });
      await winner.put!(ref, { ...secret, tokens: { ...secret.tokens, access_token: "synthetic-winner" } });
    });
    await expect(stale.beginRefresh!()).rejects.toThrow();
    await expect(stale.put!(ref, secret)).rejects.toThrow();
  });
  expect((await store.get(ref, binding) as typeof secret).tokens.access_token).toBe("synthetic-winner");
});

test("network work does not pin database connections and scoped handles expire", async () => {
  const refs = Array.from({ length: 8 }, reference);
  await Promise.all(refs.map((ref) => store.put!(ref, secret, binding)));
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await Promise.all(refs.map((ref) => store.exclusive!(ref, binding, async (scoped) => {
    await scoped.get(ref); await scoped.beginRefresh!();
    if (++arrived === refs.length) release();
    await barrier; // More pending remote requests than the adapter's five connections.
    await scoped.put!(ref, secret);
  })));
  const escaped = await store.exclusive!(refs[0]!, binding, async (scoped) => scoped);
  await expect(escaped.get(refs[0]!)).rejects.toThrow();
  await expect(escaped.put!(refs[0]!, secret)).rejects.toThrow();
  await expect(escaped.beginRefresh!()).rejects.toThrow();
});

test.each(["claim", "completion"] as const)("lost %s acknowledgement fails closed after a committed statement", async (stage) => {
  const ref = reference(); await store.put!(ref, secret, binding);
  const original = Client.prototype.query;
  const pending = new WeakSet<Client>();
  let requests = 0;
  let injected = false;
  const fault = vi.spyOn(Client.prototype, "query").mockImplementation((async function (this: Client, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    const sql = args[0];
    if (!injected && typeof sql === "string" && sql.startsWith(stage === "claim"
      ? "UPDATE public.flywheel_upstream_credentials SET refreshing=true"
      : "UPDATE public.flywheel_upstream_credentials SET key_version=")) {
      pending.add(this);
    }
    // Inject only after COMMIT: an UPDATE acknowledgement lost before COMMIT
    // is rolled back by the new short-transaction wrapper.
    if (!injected && sql === "COMMIT" && pending.has(this)) {
      injected = true;
      throw new Error("synthetic lost database acknowledgement");
    }
    return result;
  }) as typeof original);
  try {
    await expect(store.exclusive!(ref, binding, async (scoped) => {
      await scoped.get(ref); await scoped.beginRefresh!(); requests++;
      await scoped.put!(ref, { ...secret, tokens: { ...secret.tokens, access_token: "synthetic-committed" } });
      return "must not acknowledge";
    })).rejects.toThrow("Encrypted credential custody failed");
    expect(injected).toBe(true);
  } finally { fault.mockRestore(); }
  if (stage === "claim") {
    expect(requests).toBe(0);
    await expect(other.get(ref, binding)).rejects.toThrow();
  } else {
    expect(requests).toBe(1);
    expect((await other.get(ref, binding) as typeof secret).tokens.access_token).toBe("synthetic-committed");
  }
});


test("checked-out connection errors are handled and never acknowledged", async () => {
  const ref = reference();
  const original = Client.prototype.query;
  let injected = false;
  const fault = vi.spyOn(Client.prototype, "query").mockImplementation((async function (this: Client, ...args: unknown[]) {
    const result = await Reflect.apply(original, this, args);
    if (!injected && args[0] === "COMMIT") {
      injected = true;
      this.emit("error", new Error("synthetic checked-out connection loss"));
    }
    return result;
  }) as typeof original);
  try { await expect(store.put!(ref, secret, binding)).rejects.toThrow("Encrypted credential custody failed"); }
  finally { fault.mockRestore(); }
  expect(injected).toBe(true);
  // COMMIT completed, so the durable row can exist despite the rejected acknowledgement.
  expect(await other.get(ref, binding)).toEqual(secret);
});
