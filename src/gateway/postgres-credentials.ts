import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { FlywheelError, canonicalJson } from "../contracts.js";
import { CredentialBinding } from "../db/registry.js";
import { OAuthCredential, type CredentialStore } from "./credentials.js";

const unavailable = () => new FlywheelError("operation_unavailable", "Encrypted credential custody failed; verify storage, binding and key configuration or reconcile an interrupted refresh. No credential was acknowledged.");

/** Run explicitly as a schema owner. Runtime roles need SELECT/INSERT/UPDATE only. */
export const CREDENTIAL_SCHEMA = `CREATE TABLE IF NOT EXISTS flywheel_upstream_credentials (
  reference text PRIMARY KEY,
  binding text NOT NULL,
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
}

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
  // Scope a versioned read/claim/write sequence; concurrency is fenced by SQL CAS,
  // not by a session lock. Every statement can use a different pooled connection.
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
          const result = await pool.query<EnvelopeRow>("SELECT * FROM flywheel_upstream_credentials WHERE reference=$1", [ref]);
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
          const result = await pool.query<{ token_version: number }>("UPDATE flywheel_upstream_credentials SET refreshing=true,token_version=token_version+1 WHERE reference=$1 AND binding=$2 AND token_version=$3 AND refreshing=false RETURNING token_version", [reference, binding, version]);
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
            ? await pool.query("INSERT INTO flywheel_upstream_credentials (reference,binding,key_version,nonce,ciphertext,tag) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", params)
            : await pool.query("UPDATE flywheel_upstream_credentials SET key_version=$3,nonce=$4,ciphertext=$5,tag=$6,token_version=token_version+1,refreshing=false WHERE reference=$1 AND binding=$2 AND token_version=$7 AND refreshing=$8", [...params, version, claimed]);
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
