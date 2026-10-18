/**
 * Persistence for grants and OAuth state (TOO-77). Codes and tokens are stored
 * only as SHA-256 hashes; plaintext never reaches the graph.
 */
import { createHash } from "node:crypto";
import { canonicalJson, Grant, type Grant as GrantRecord } from "../contracts.js";
import type { GraphClient } from "./client.js";
import type { IndexSpec } from "./schema.js";

export const AUTH_INDEX_SPECS: readonly IndexSpec[] = [
  { label: "Grant", property: "grant_id", unique: true },
  { label: "OAuthClient", property: "client_id", unique: true },
  { label: "OAuthCode", property: "code_hash", unique: true },
  { label: "OAuthToken", property: "token_hash", unique: true },
  { label: "OAuthFamily", property: "family_id", unique: true },
];

export const hashSecret = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/* ------------------------------------------------------------------ grants */

export async function insertGrant(db: GraphClient, grant: GrantRecord): Promise<void> {
  await db.query(
    "CREATE (:Grant {grant_id: $id, owner_id: $owner, revoked_at: null, doc: $doc})",
    { id: grant.grant_id, owner: grant.owner_id, doc: canonicalJson(grant) },
    "creating a grant",
  );
}

export async function getGrant(db: GraphClient, grantId: string): Promise<GrantRecord | null> {
  const rows = await db.roQuery<{ doc: string }>("MATCH (g:Grant {grant_id: $id}) RETURN g.doc AS doc", { id: grantId }, "reading a grant");
  return rows[0] ? Grant.parse(JSON.parse(rows[0].doc)) : null;
}

export async function listGrants(db: GraphClient, ownerId: string): Promise<GrantRecord[]> {
  const rows = await db.roQuery<{ doc: string }>(
    "MATCH (g:Grant {owner_id: $owner}) RETURN g.doc AS doc ORDER BY g.grant_id",
    { owner: ownerId },
    "listing grants",
  );
  return rows.map((r) => Grant.parse(JSON.parse(r.doc)));
}

/** Revokes the grant and every token issued under it. */
export async function revokeGrant(db: GraphClient, grantId: string, at: string, ownerId: string): Promise<boolean> {
  const grant = await getGrant(db, grantId);
  if (!grant || grant.owner_id !== ownerId) return false;
  const revoked = { ...grant, revoked_at: grant.revoked_at ?? at };
  await db.query(
    "MATCH (g:Grant {grant_id: $id, owner_id: $owner}) SET g.revoked_at = $at, g.doc = $doc",
    { id: grantId, owner: ownerId, at, doc: canonicalJson(revoked) },
    "revoking a grant",
  );
  await db.query(
    "MATCH (t:OAuthToken {grant_id: $id}) WHERE t.revoked_at IS NULL SET t.revoked_at = $at",
    { id: grantId, at: Math.floor(Date.parse(at) / 1000) },
    "revoking a grant's tokens",
  );
  return true;
}

/* ----------------------------------------------------------------- clients */

export async function insertClient(db: GraphClient, clientId: string, info: Record<string, unknown>): Promise<void> {
  await db.query(
    "CREATE (:OAuthClient {client_id: $id, doc: $doc})",
    { id: clientId, doc: JSON.stringify(info) },
    "registering an OAuth client",
  );
}

export async function getClient(db: GraphClient, clientId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.roQuery<{ doc: string }>(
    "MATCH (c:OAuthClient {client_id: $id}) RETURN c.doc AS doc",
    { id: clientId },
    "reading an OAuth client",
  );
  return rows[0] ? (JSON.parse(rows[0].doc) as Record<string, unknown>) : null;
}

/* ------------------------------------------------------------------- codes */

export interface StoredCode {
  family_id: string;
  client_id: string;
  grant_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scopes: string[];
  expires_at: number;
}

export async function insertCode(db: GraphClient, code: string, value: StoredCode): Promise<void> {
  await db.query(
    "CREATE (:OAuthCode {code_hash: $hash, used_at: null, expires_at: $exp, doc: $doc})",
    { hash: hashSecret(code), exp: value.expires_at, doc: JSON.stringify(value) },
    "storing an authorization code",
  );
}

export async function peekCode(db: GraphClient, code: string): Promise<StoredCode | null> {
  const rows = await db.roQuery<{ doc: string }>(
    "MATCH (c:OAuthCode {code_hash: $hash}) RETURN c.doc AS doc",
    { hash: hashSecret(code) },
    "reading an authorization code",
  );
  return rows[0] ? (JSON.parse(rows[0].doc) as StoredCode) : null;
}

/** Single use: atomically marks the code used; null if unknown, used or expired. */
export async function consumeCode(db: GraphClient, code: string, nowSec: number): Promise<StoredCode | null> {
  const rows = await db.query<{ doc: string }>(
    `MATCH (c:OAuthCode {code_hash: $hash}) WHERE c.used_at IS NULL AND c.expires_at > $now
     SET c.used_at = $now RETURN c.doc AS doc`,
    { hash: hashSecret(code), now: nowSec },
    "consuming an authorization code",
  );
  return rows[0] ? (JSON.parse(rows[0].doc) as StoredCode) : null;
}

/* ------------------------------------------------------------------ tokens */

export interface StoredToken {
  kind: "access" | "refresh";
  client_id: string;
  grant_id: string;
  /** One family per consent; identifies the client session and supports reuse detection. */
  family_id: string;
  resource: string;
  scopes: string[];
  expires_at: number;
}

/** Mint both credentials in one write, guarded by the live grant and session family.
 * Rotation and replacement issuance share a query so replay cannot race a later mint.
 */
export async function issueTokenPair(
  db: GraphClient,
  access: string,
  refresh: string,
  value: Omit<StoredToken, "kind" | "expires_at">,
  ownerId: string,
  nowSec: number,
  accessExpires: number,
  refreshExpires: number,
  previousRefresh?: string,
): Promise<boolean> {
  const familyClause = previousRefresh === undefined
    ? `MERGE (f:OAuthFamily {family_id: $family})
       ON CREATE SET f.revoked_at = null
       WITH g, f WHERE f.revoked_at IS NULL`
    : `MATCH (f:OAuthFamily {family_id: $family}), (old:OAuthToken {token_hash: $previous, kind: 'refresh', family_id: $family})
       WHERE f.revoked_at IS NULL AND old.revoked_at IS NULL AND old.expires_at > $now
       SET old.revoked_at = $now`;
  const rows = await db.query<{ ok: boolean }>(
    `MATCH (g:Grant {grant_id: $grant, owner_id: $owner}) WHERE g.revoked_at IS NULL
     ${familyClause}
     CREATE (:OAuthToken {token_hash: $access, kind: 'access', client_id: $client, grant_id: $grant,
       family_id: $family, expires_at: $accessExp, revoked_at: null, doc: $accessDoc}),
       (:OAuthToken {token_hash: $refresh, kind: 'refresh', client_id: $client, grant_id: $grant,
       family_id: $family, expires_at: $refreshExp, revoked_at: null, doc: $refreshDoc})
     RETURN true AS ok`,
    {
      owner: ownerId, grant: value.grant_id, family: value.family_id, client: value.client_id,
      previous: previousRefresh === undefined ? "" : hashSecret(previousRefresh), now: nowSec,
      access: hashSecret(access), refresh: hashSecret(refresh), accessExp: accessExpires, refreshExp: refreshExpires,
      accessDoc: JSON.stringify({ ...value, kind: "access", expires_at: accessExpires }),
      refreshDoc: JSON.stringify({ ...value, kind: "refresh", expires_at: refreshExpires }),
    },
    "issuing an OAuth token pair",
  );
  return rows.length === 1;
}

export async function getToken(
  db: GraphClient,
  token: string,
): Promise<(StoredToken & { revoked: boolean }) | null> {
  const rows = await db.roQuery<{ doc: string; revoked_at: unknown; family_id: string | null; family_revoked_at: unknown }>(
    `MATCH (t:OAuthToken {token_hash: $hash})
     OPTIONAL MATCH (f:OAuthFamily {family_id: t.family_id})
     RETURN t.doc AS doc, t.revoked_at AS revoked_at, f.family_id AS family_id, f.revoked_at AS family_revoked_at`,
    { hash: hashSecret(token) },
    "reading a token",
  );
  const row = rows[0];
  return row ? { ...(JSON.parse(row.doc) as StoredToken), revoked: row.revoked_at !== null || !row.family_id || row.family_revoked_at !== null } : null;
}

/** Durable tombstone also blocks concurrent/future replacement issuance. */
export async function revokeFamily(db: GraphClient, familyId: string, at: number): Promise<void> {
  await db.query(
    "MERGE (f:OAuthFamily {family_id: $family}) SET f.revoked_at = coalesce(f.revoked_at, $at)",
    { family: familyId, at },
    "revoking a token family",
  );
}
