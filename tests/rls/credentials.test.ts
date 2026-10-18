import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { beforeAll, afterAll, expect, test } from "vitest";
import { createPostgresCredentialStore } from "../../src/gateway/postgres-credentials.js";
import type { CredentialBinding } from "../../src/db/registry.js";

const url = process.env.TEST_CREDENTIAL_RLS_ADMIN_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) throw new Error("Set TEST_CREDENTIAL_RLS_ADMIN_URL to a fresh disposable loopback database with role-creation privileges.");
const admin = new Pool({ connectionString: url });
const runtimeUrl = new URL(url); runtimeUrl.username = "flywheel_credential_runtime"; runtimeUrl.password = "";
const runtime = new Pool({ connectionString: runtimeUrl.toString(), max: 1 });
const options = { connectionString: runtimeUrl.toString(), keys: { test: randomBytes(32) }, activeKeyVersion: "test", tls: false, requireRls: true };
const store = createPostgresCredentialStore(options);
const other = createPostgresCredentialStore(options);
const binding: CredentialBinding = { schema_version: 1, owner_id: "11111111-1111-4111-8111-111111111111", created_at: new Date().toISOString(),
  auth_config_ref: "test-auth", application: "textkit", repo_id: "test/repo", commit_sha: "a".repeat(40), deployment_id: "test-a",
  url: "http://127.0.0.1:3111/mcp", resource: "http://127.0.0.1:3111/mcp", audience: "synthetic", scopes: ["mcp"], environment: "local", issuer: "http://127.0.0.1:3111" };
const second = { ...binding, owner_id: "22222222-2222-4222-8222-222222222222" };
const secret = { issuer: binding.issuer, environment: binding.environment, resource: binding.resource, audience: binding.audience,
  obtained_at: 1, client: { client_id: "synthetic-client" }, tokens: { access_token: "synthetic-access", refresh_token: "synthetic-refresh", token_type: "Bearer" } };
const refA = `postgres:${randomUUID()}`; const refB = `postgres:${randomUUID()}`;
let bindingA: string; let bindingB: string;
beforeAll(async () => {
  await admin.query("CREATE ROLE flywheel_credential_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION");
  await admin.query("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE ROLE credential_schema_owner");
  // Reproduce the pre-migration schema and a legacy non-UUID owner without
  // claiming ownership migration into any newly authenticated user's namespace.
  await admin.query(`CREATE TABLE public.flywheel_upstream_credentials (
    reference text PRIMARY KEY, binding text NOT NULL, key_version text NOT NULL,
    nonce bytea NOT NULL, ciphertext bytea NOT NULL, tag bytea NOT NULL,
    token_version integer NOT NULL DEFAULT 1, refreshing boolean NOT NULL DEFAULT false)`);
  await admin.query("INSERT INTO public.flywheel_upstream_credentials(reference,binding,key_version,nonce,ciphertext,tag) VALUES('postgres:legacy',$1,'test',$2,$3,$4)",
    [JSON.stringify({ owner_id: "legacy-owner" }), randomBytes(12), randomBytes(8), randomBytes(16)]);
  await admin.query("ALTER TABLE public.flywheel_upstream_credentials OWNER TO credential_schema_owner");
  await admin.query("GRANT ALL ON public.flywheel_upstream_credentials TO anon, authenticated, service_role; GRANT SELECT(ciphertext) ON public.flywheel_upstream_credentials TO PUBLIC, authenticated");
  await admin.query(await readFile(new URL("../../migrations/001_credential_rls.sql", import.meta.url), "utf8"));
  await store.put!(refA, secret, binding); await store.put!(refB, secret, second);
  const rows = await admin.query("SELECT reference,binding FROM public.flywheel_upstream_credentials");
  bindingA = rows.rows.find((r) => r.reference === refA).binding;
  bindingB = rows.rows.find((r) => r.reference === refB).binding;
});
afterAll(async () => { await store.close(); await other.close(); await runtime.end(); await admin.end(); });

async function asOwner<T>(owner: string, exact: string, run: (client: PoolClient) => Promise<T>) {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('flywheel.credential_owner',$1,true),set_config('flywheel.credential_binding',$2,true)", [owner, exact]);
    return await run(client);
  } finally { await client.query("ROLLBACK"); client.release(); }
}

test("migration backfills legacy owner without reassignment and rejects implicit policy merging", async () => {
  expect((await admin.query("SELECT owner_id FROM public.flywheel_upstream_credentials WHERE reference='postgres:legacy'")).rows[0].owner_id).toBe("legacy-owner");
  await expect(admin.query(await readFile(new URL("../../migrations/001_credential_rls.sql", import.meta.url), "utf8"))).rejects.toThrow("Review existing credential policies");
  await admin.query("ROLLBACK");
});

test("normal runtime has no rows without context; wrong owner or exact binding denies rows", async () => {
  expect((await runtime.query("SELECT * FROM public.flywheel_upstream_credentials")).rows).toEqual([]);
  await asOwner(binding.owner_id, bindingA, async (c) => {
    expect((await c.query("SELECT reference FROM public.flywheel_upstream_credentials")).rows).toEqual([{ reference: refA }]);
    expect((await c.query("UPDATE public.flywheel_upstream_credentials SET refreshing=true WHERE reference=$1", [refB])).rowCount).toBe(0);
  });
  await asOwner(binding.owner_id, bindingB, async (c) => expect((await c.query("SELECT * FROM public.flywheel_upstream_credentials")).rows).toEqual([]));
  expect((await runtime.query("SELECT * FROM public.flywheel_upstream_credentials")).rows).toEqual([]);
});

test("cross-owner inserts, identity mutations, truncate, policy changes and role escalation fail", async () => {
  await expect(asOwner(binding.owner_id, bindingA, async (c) => c.query("INSERT INTO public.flywheel_upstream_credentials(reference,binding,owner_id,key_version,nonce,ciphertext,tag) VALUES($1,$2,$3,'test',$4,$5,$6)", [`postgres:${randomUUID()}`, bindingB, second.owner_id, randomBytes(12), randomBytes(10), randomBytes(16)]))).rejects.toMatchObject({ code: "42501" });
  for (const sql of ["UPDATE public.flywheel_upstream_credentials SET owner_id='other'", "UPDATE public.flywheel_upstream_credentials SET binding='{}'", "UPDATE public.flywheel_upstream_credentials SET reference='postgres:other'", "TRUNCATE public.flywheel_upstream_credentials", "ALTER TABLE public.flywheel_upstream_credentials DISABLE ROW LEVEL SECURITY", "SET ROLE credential_schema_owner", "SET ROLE service_role", "ALTER ROLE flywheel_credential_runtime BYPASSRLS"]) {
    await expect(asOwner(binding.owner_id, bindingA, async (c) => c.query(sql))).rejects.toMatchObject({ code: "42501" });
  }
});

test("browser and service roles retain no table or column access even with forged owner context", async () => {
  for (const role of ["anon", "authenticated", "service_role"]) {
    const c = await admin.connect();
    try {
      await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`);
      await c.query("SELECT set_config('flywheel.credential_owner',$1,true),set_config('flywheel.credential_binding',$2,true)", [binding.owner_id, bindingA]);
      await expect(c.query("SELECT ciphertext FROM public.flywheel_upstream_credentials")).rejects.toMatchObject({ code: "42501" });
    } finally { await c.query("ROLLBACK"); c.release(); }
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect((await admin.query("SELECT has_table_privilege($1,'public.flywheel_upstream_credentials',$2) AS allowed", [role, privilege])).rows[0].allowed).toBe(false);
  }
});

test("FORCE subjects ordinary table owner to default deny, while administrative bypass remains explicit", async () => {
  const c = await admin.connect();
  try { await c.query("BEGIN; SET LOCAL ROLE credential_schema_owner"); expect((await c.query("SELECT * FROM public.flywheel_upstream_credentials")).rows).toEqual([]); }
  finally { await c.query("ROLLBACK"); c.release(); }
  expect((await admin.query("SELECT * FROM public.flywheel_upstream_credentials")).rowCount).toBeGreaterThanOrEqual(2);
});

test("least-privilege adapter preserves CAS refresh, stale-writer rejection and durable interrupted claims", async () => {
  expect(await store.get(refA, binding)).toEqual(secret);
  await expect(store.get(refA, second)).rejects.toThrow();
  await store.exclusive!(refA, binding, async (stale) => {
    await stale.get(refA);
    await other.exclusive!(refA, binding, async (winner) => {
      await winner.get(refA); await winner.beginRefresh!();
      await expect(stale.beginRefresh!()).rejects.toThrow(); await expect(stale.put!(refA, secret)).rejects.toThrow();
      await winner.put!(refA, secret);
    });
  });
  await expect(store.exclusive!(refB, second, async (scoped) => { await scoped.get(refB); await scoped.beginRefresh!(); throw new Error("remote timeout"); })).rejects.toThrow();
  await expect(other.get(refB, second)).rejects.toThrow();
  expect((await admin.query("SELECT refreshing FROM public.flywheel_upstream_credentials WHERE reference=$1", [refB])).rows[0].refreshing).toBe(true);
});


test("required RLS rejects administrator connections and permissive policy drift", async () => {
  const privileged = createPostgresCredentialStore({ ...options, connectionString: url! });
  try { await expect(privileged.get(refA, binding)).rejects.toThrow(); }
  finally { await privileged.close(); }
  await admin.query("CREATE POLICY unexpected_allow ON public.flywheel_upstream_credentials TO flywheel_credential_runtime USING (true)");
  try { await expect(store.get(refA, binding)).rejects.toThrow(); }
  finally { await admin.query("DROP POLICY unexpected_allow ON public.flywheel_upstream_credentials"); }
  expect(await store.get(refA, binding)).toEqual(secret);
});


test("required RLS rejects changed predicate and restored browser column grants", async () => {
  const original = "(owner_id = nullif(current_setting('flywheel.credential_owner',true),'') AND binding = nullif(current_setting('flywheel.credential_binding',true),''))";
  await admin.query("ALTER POLICY credential_backend_scope ON public.flywheel_upstream_credentials USING (true)");
  try { await expect(store.get(refA, binding)).rejects.toThrow(); }
  finally { await admin.query(`ALTER POLICY credential_backend_scope ON public.flywheel_upstream_credentials USING (${original})`); }
  await admin.query("GRANT SELECT(ciphertext) ON public.flywheel_upstream_credentials TO authenticated");
  try { await expect(store.get(refA, binding)).rejects.toThrow(); }
  finally { await admin.query("REVOKE SELECT(ciphertext) ON public.flywheel_upstream_credentials FROM authenticated"); }
  expect(await store.get(refA, binding)).toEqual(secret);
});
