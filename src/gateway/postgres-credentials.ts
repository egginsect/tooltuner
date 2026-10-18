import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import { FlywheelError, canonicalJson } from "../contracts.js";
import { CredentialBinding } from "../db/registry.js";
import { OAuthCredential, type CredentialStore } from "./credentials.js";

const unavailable = () => new FlywheelError("operation_unavailable", "Encrypted credential custody failed; verify storage, binding and key configuration or reconcile an interrupted refresh. No credential was acknowledged.");

/** Run explicitly as a schema owner. Runtime roles need SELECT/INSERT/UPDATE only. */
export const CREDENTIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS public.flywheel_upstream_credentials (
  reference text PRIMARY KEY,
  binding text NOT NULL,
  owner_id text NOT NULL,
  CONSTRAINT credential_binding_owner CHECK (
    jsonb_typeof(binding::jsonb -> 'owner_id') = 'string'
    AND (binding::jsonb ->> 'owner_id') IS NOT NULL
    AND owner_id = (binding::jsonb ->> 'owner_id')
    AND length(owner_id) > 0
  ),
  key_version text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL,
  tag bytea NOT NULL CHECK (octet_length(tag) = 16),
  token_version integer NOT NULL DEFAULT 1 CHECK (token_version > 0),
  refreshing boolean NOT NULL DEFAULT false
)`;

interface EnvelopeRow {
  binding: string; key_version: string; nonce: Buffer; ciphertext: Buffer; tag: Buffer;
  token_version: number; refreshing: boolean;
}

/** Identity is supplied by the trusted registry/owner, never by the stored row. */
function identity(reference: string, input?: CredentialBinding): string {
  if (!/^postgres:[A-Za-z0-9._/-]+$/.test(reference) || !input) throw unavailable();
  const { created_at: _created, ...binding } = CredentialBinding.parse(input);
  return canonicalJson({ domain: "flywheel-upstream-credential-v1", reference, ...binding });
}

export interface PostgresCredentialOptions {
  connectionString: string;
  /** Separate secret-manager/environment injection. No key material goes into PostgreSQL. */
  keys: Readonly<Record<string, Buffer>>;
  activeKeyVersion: string;
  /** False is permitted only for explicit loopback development. */
  tls: boolean;
  /** Mandatory for hosted multiuser custody; false is legacy/local compatibility only. */
  requireRls?: boolean;
}

// Fail closed if the connection cannot prove the reviewed backend-only RLS boundary.
// Exact policy deparsing deliberately rejects unreviewed policy edits/version differences.
const RLS_SCOPE_EXPRESSION = "((owner_id = NULLIF(current_setting('flywheel.credential_owner'::text, true), ''::text)) AND (binding = NULLIF(current_setting('flywheel.credential_binding'::text, true), ''::text)))";
const RLS_RUNTIME_CHECK = `SELECT (
  r.rolname = 'flywheel_credential_runtime' AND session_user = current_user
  AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
  AND c.relowner <> r.oid AND c.relrowsecurity AND c.relforcerowsecurity
  AND NOT has_schema_privilege(r.oid, 'public', 'CREATE')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=r.oid)
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
  AND (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid=c.oid) = 1
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid
    AND p.polname='credential_backend_scope' AND p.polcmd='*' AND p.polpermissive
    AND p.polroles=ARRAY[r.oid]
    AND pg_catalog.pg_get_expr(p.polqual,p.polrelid)=$1
    AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)=$1)
  AND NOT has_table_privilege(r.oid,c.oid,'DELETE,TRUNCATE,REFERENCES,TRIGGER')
  AND NOT has_column_privilege(r.oid,c.oid,'reference','UPDATE')
  AND NOT has_column_privilege(r.oid,c.oid,'binding','UPDATE')
  AND NOT has_column_privilege(r.oid,c.oid,'owner_id','UPDATE')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles browser WHERE rolname IN ('anon','authenticated','service_role')
    AND (has_table_privilege(browser.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(browser.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
) AS safe FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
WHERE r.rolname=current_user AND c.oid=to_regclass('public.flywheel_upstream_credentials')`;

export function createPostgresCredentialStore(options: PostgresCredentialOptions): CredentialStore & { initialize(): Promise<void>; close(): Promise<void> } {
  const keys = new Map(Object.entries(options.keys).map(([version, key]) => [version, Buffer.from(key)]));
  if (!keys.has(options.activeKeyVersion) || [...keys].some(([version, key]) => !/^[A-Za-z0-9._-]{1,64}$/.test(version) || key.length !== 32)) throw unavailable();
  try {
    const url = new URL(options.connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash ||
      (!options.tls && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw unavailable();
  } catch { throw unavailable(); }
  const pool = new Pool({ connectionString: options.connectionString, ssl: options.tls ? { rejectUnauthorized: true } : false,
    max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 1000, statement_timeout: 10000, query_timeout: 12000,
    allowExitOnIdle: true });
  // Do not forward driver errors, connection strings, SQL parameters or secrets to logs.
  pool.on("error", () => undefined);
  const seal = (binding: string, value: unknown) => {
    const secret = OAuthCredential.parse(value);
    const nonce = randomBytes(12);
    const key_version = options.activeKeyVersion;
    const cipher = createCipheriv("aes-256-gcm", keys.get(key_version)!, nonce);
    cipher.setAAD(Buffer.from(canonicalJson({ binding, key_version, algorithm: "AES-256-GCM" })));
    const plaintext = Buffer.from(canonicalJson(secret));
    try { return { key_version, nonce, ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]), tag: cipher.getAuthTag() }; }
    finally { plaintext.fill(0); }
  };
  const open = (binding: string, row: EnvelopeRow) => {
    const key = keys.get(row.key_version);
    if (!key || row.binding !== binding || row.refreshing) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", key, row.nonce);
    decipher.setAAD(Buffer.from(canonicalJson({ binding, key_version: row.key_version, algorithm: "AES-256-GCM" })));
    decipher.setAuthTag(row.tag);
    const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
    try { return OAuthCredential.parse(JSON.parse(plaintext.toString("utf8"))); }
    finally { plaintext.fill(0); }
  };
  // The backend derives this context from the verified principal and owner-scoped
  // registry. GUCs narrow accidental SQL access; they cannot constrain a compromised
  // backend that has this database login. Browser roles have no credential access.
  async function scopedQuery<T extends QueryResultRow = QueryResultRow>(owner: string, binding: string, sql: string, values: unknown[]) {
    const client = await pool.connect();
    let failed = false;
    const onError = () => { failed = true; };
    client.on("error", onError);
    try {
      await client.query("BEGIN");
      if (failed) throw unavailable();
      if (options.requireRls) {
        const check = await client.query<{ safe: boolean }>(RLS_RUNTIME_CHECK, [RLS_SCOPE_EXPRESSION]);
        if (failed || check.rows.length !== 1 || check.rows[0]?.safe !== true) throw unavailable();
      }
      await client.query("SELECT pg_catalog.set_config('flywheel.credential_owner', $1, true), pg_catalog.set_config('flywheel.credential_binding', $2, true)", [owner, binding]);
      if (failed) throw unavailable();
      const result = await client.query<T>(sql, values);
      if (failed) throw unavailable();
      await client.query("COMMIT");
      if (failed) throw unavailable();
      return result;
    } catch (error) {
      failed = true;
      try { await client.query("ROLLBACK"); } catch { /* Discard uncertain connections. */ }
      throw error;
    } finally { client.removeListener("error", onError); client.release(failed); }
  }
  // Scope a versioned read/claim/write sequence; concurrency is fenced by SQL CAS,
  // not by a session lock. Each short transaction can use a different connection.
  // No transaction or checked-out connection spans remote OAuth network work.
  async function exclusive<T>(reference: string, target: CredentialBinding, work: (store: CredentialStore) => Promise<T>): Promise<T> {
    let active = true;
    try {
      const binding = identity(reference, target);
      let version: number | undefined;
      let claimed = false;
      const assertActive = () => { if (!active) throw unavailable(); };
      const scoped: CredentialStore = {
        custody: "encrypted_postgres",
        async get(ref, input = target) {
          assertActive();
          if (ref !== reference || identity(ref, input) !== binding) throw unavailable();
          const result = await scopedQuery<EnvelopeRow>(target.owner_id, binding, "SELECT * FROM public.flywheel_upstream_credentials WHERE reference=$1", [ref]);
          const row = result.rows[0];
          if (!row) throw unavailable();
          const value = open(binding, row);
          version = row.token_version;
          return value;
        },
        async beginRefresh() {
          assertActive();
          if (version === undefined || claimed) throw unavailable();
          // One committed statement claims this version before any token request. A lost
          // acknowledgement must never be retried: the durable fence may already exist.
          const result = await scopedQuery<{ token_version: number }>(target.owner_id, binding, "UPDATE public.flywheel_upstream_credentials SET refreshing=true,token_version=token_version+1 WHERE reference=$1 AND binding=$2 AND token_version=$3 AND refreshing=false RETURNING token_version", [reference, binding, version]);
          if (result.rowCount !== 1) throw unavailable();
          version = result.rows[0]!.token_version;
          claimed = true;
        },
        async put(ref, value, input = target) {
          assertActive();
          if (ref !== reference || identity(ref, input) !== binding) throw unavailable();
          const secret = OAuthCredential.parse(value);
          if (secret.issuer !== target.issuer || secret.environment !== target.environment || secret.resource !== target.resource || secret.audience !== target.audience) throw unavailable();
          const e = seal(binding, secret);
          const params = [reference, binding, e.key_version, e.nonce, e.ciphertext, e.tag];
          const result = version === undefined
            ? await scopedQuery(target.owner_id, binding, "INSERT INTO public.flywheel_upstream_credentials (reference,binding,key_version,nonce,ciphertext,tag,owner_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", [...params, target.owner_id])
            : await scopedQuery(target.owner_id, binding, "UPDATE public.flywheel_upstream_credentials SET key_version=$3,nonce=$4,ciphertext=$5,tag=$6,token_version=token_version+1,refreshing=false WHERE reference=$1 AND binding=$2 AND token_version=$7 AND refreshing=$8", [...params, version, claimed]);
          if (result.rowCount !== 1) throw unavailable();
          version = (version ?? 0) + 1;
          claimed = false;
        },
      };
      return await work(scoped);
    } catch { throw unavailable(); }
    finally { active = false; }
  }

  return {
    custody: "encrypted_postgres",
    exclusive,
    async get(reference, binding) { identity(reference, binding); return exclusive(reference, binding!, (store) => store.get(reference, binding)); },
    async put(reference, value, binding) { identity(reference, binding); return exclusive(reference, binding!, (store) => store.put!(reference, value, binding)); },
    async initialize() { try { await pool.query(CREDENTIAL_SCHEMA); } catch { throw unavailable(); } },
    async close() { await pool.end(); for (const key of keys.values()) key.fill(0); },
  };
}
