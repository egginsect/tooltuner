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
  { label: "OAuthPending", property: "request_hash", unique: true },
  { label: "OAuthPending", property: "expires_at" },
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
  owner_id?: string;
  subject?: string;
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
  owner_id?: string;
  subject?: string;
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
  if (value.owner_id !== undefined && value.owner_id !== ownerId) throw new Error("Token owner does not match grant namespace");
  const familyClause = previousRefresh === undefined
    ? `MERGE (f:OAuthFamily {family_id: $family})
       ON CREATE SET f.revoked_at = null, f.owner_id = $owner, f.subject = $subject
       WITH g, f WHERE f.revoked_at IS NULL AND f.owner_id = $owner AND f.subject = $subject`
    : `MATCH (f:OAuthFamily {family_id: $family}), (old:OAuthToken {token_hash: $previous, kind: 'refresh', family_id: $family})
       WHERE f.revoked_at IS NULL AND f.owner_id = $owner AND f.subject = $subject
         AND old.owner_id = $owner AND old.revoked_at IS NULL AND old.expires_at > $now
       SET old.revoked_at = $now`;
  const rows = await db.query<{ ok: boolean }>(
    `MATCH (g:Grant {grant_id: $grant, owner_id: $owner}) WHERE g.revoked_at IS NULL
     ${familyClause}
     CREATE (:OAuthToken {token_hash: $access, kind: 'access', client_id: $client, grant_id: $grant,
       family_id: $family, owner_id: $owner, expires_at: $accessExp, revoked_at: null, doc: $accessDoc}),
       (:OAuthToken {token_hash: $refresh, kind: 'refresh', client_id: $client, grant_id: $grant,
       family_id: $family, owner_id: $owner, expires_at: $refreshExp, revoked_at: null, doc: $refreshDoc})
     RETURN true AS ok`,
    {
      owner: ownerId, subject: value.subject ?? `owner:${ownerId}`, grant: value.grant_id, family: value.family_id, client: value.client_id,
      previous: previousRefresh === undefined ? "" : hashSecret(previousRefresh), now: nowSec,
      access: hashSecret(access), refresh: hashSecret(refresh), accessExp: accessExpires, refreshExp: refreshExpires,
      accessDoc: JSON.stringify({ ...value, owner_id: ownerId, subject: value.subject ?? `owner:${ownerId}`, kind: "access", expires_at: accessExpires }),
      refreshDoc: JSON.stringify({ ...value, owner_id: ownerId, subject: value.subject ?? `owner:${ownerId}`, kind: "refresh", expires_at: refreshExpires }),
    },
    "issuing an OAuth token pair",
  );
  return rows.length === 1;
}

export async function getToken(
  db: GraphClient,
  token: string,
): Promise<(StoredToken & { revoked: boolean }) | null> {
  const rows = await db.roQuery<{ doc: string; revoked_at: unknown; family_id: string | null; family_revoked_at: unknown; token_owner: string | null; family_owner: string | null; family_subject: string | null }>(
    `MATCH (t:OAuthToken {token_hash: $hash})
     OPTIONAL MATCH (f:OAuthFamily {family_id: t.family_id})
     RETURN t.doc AS doc, t.revoked_at AS revoked_at, f.family_id AS family_id, f.revoked_at AS family_revoked_at, t.owner_id AS token_owner, f.owner_id AS family_owner, f.subject AS family_subject`,
    { hash: hashSecret(token) },
    "reading a token",
  );
  const row = rows[0];
  if (!row) return null;
  const stored = JSON.parse(row.doc) as StoredToken;
  const mismatched = stored.owner_id !== undefined && (stored.owner_id !== row.token_owner || stored.owner_id !== row.family_owner || stored.subject !== row.family_subject);
  return { ...stored, revoked: mismatched || row.revoked_at !== null || !row.family_id || row.family_revoked_at !== null };
}

/** Durable tombstone also blocks concurrent/future replacement issuance. */
export async function revokeFamily(db: GraphClient, familyId: string, at: number): Promise<void> {
  await db.query(
    "MERGE (f:OAuthFamily {family_id: $family}) SET f.revoked_at = coalesce(f.revoked_at, $at)",
    { family: familyId, at },
    "revoking a token family",
  );
}

/* --------------------------------------------------------- browser consent */

export interface PendingBinding { ownerId: string; resource: string }
const pendingParams = (binding: PendingBinding, requestId: string, now: number) => ({
  owner: binding.ownerId, resource: binding.resource, hash: hashSecret(requestId), now,
});

/** Expired requests are unusable even before opportunistic physical cleanup. */
export async function insertPendingAuthorization(db: GraphClient, binding: PendingBinding, requestId: string,
  document: string, expiresAt: number, now: number): Promise<boolean> {
  await db.query("MATCH (p:OAuthPending {owner_id: $owner}) WHERE p.expires_at <= $now DELETE p",
    { owner: binding.ownerId, now }, "removing expired authorization requests");
  const rows = await db.query<{ created: boolean }>(
    `OPTIONAL MATCH (p:OAuthPending {owner_id: $owner, resource: $resource}) WHERE p.expires_at > $now
     WITH count(p) AS total WHERE total < 1000
     CREATE (:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource,
       expires_at: $expires, state: 'login', doc: $doc}) RETURN true AS created`,
    { ...pendingParams(binding, requestId, now), expires: expiresAt, doc: document }, "storing an authorization request");
  return rows[0]?.created === true;
}

export async function readPendingAuthorization(db: GraphClient, binding: PendingBinding, requestId: string, now: number): Promise<string | null> {
  const rows = await db.roQuery<{ doc: string }>(
    `MATCH (p:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource})
     WHERE p.expires_at > $now AND p.state IN ['login', 'selection'] RETURN p.doc AS doc`,
    pendingParams(binding, requestId, now), "reading an authorization request");
  return rows[0]?.doc ?? null;
}

/** Claim once across instances before loading grant metadata. Failure stays closed. */
export async function claimPendingLogin(db: GraphClient, binding: PendingBinding, requestId: string, now: number): Promise<string | null> {
  const rows = await db.query<{ doc: string }>(
    `MATCH (p:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource})
     WHERE p.expires_at > $now AND p.state = 'login' SET p.state = 'claimed' RETURN p.doc AS doc`,
    pendingParams(binding, requestId, now), "claiming an owner login");
  return rows[0]?.doc ?? null;
}

export async function finishPendingLogin(db: GraphClient, binding: PendingBinding, requestId: string, now: number,
  document: string, selectionHash: string, selectionExpiresAt: number): Promise<boolean> {
  const rows = await db.query<{ completed: boolean }>(
    `MATCH (p:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource})
     WHERE p.expires_at > $now AND p.state = 'claimed'
     SET p.state = 'selection', p.doc = $doc, p.selection_hash = $selection, p.selection_expires_at = $expires
     RETURN true AS completed`,
    { ...pendingParams(binding, requestId, now), doc: document, selection: selectionHash, expires: selectionExpiresAt },
    "persisting a grant selection capability");
  return rows[0]?.completed === true;
}

/** Approval must atomically consume the matching, unexpired selection capability. */
export async function consumePendingAuthorization(db: GraphClient, binding: PendingBinding, requestId: string,
  now: number, approve: boolean, selectionHash: string): Promise<string | null> {
  const rows = await db.query<{ doc: string }>(
    `MATCH (p:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource})
     WHERE p.expires_at > $now AND p.state IN ['login', 'selection']
       AND ($approve = false OR (p.state = 'selection' AND p.selection_hash = $selection AND p.selection_expires_at > $now))
     SET p.state = 'consumed' RETURN p.doc AS doc`,
    { ...pendingParams(binding, requestId, now), approve, selection: selectionHash }, "consuming an authorization request");
  return rows[0]?.doc ?? null;
}

/** Each browser OAuth attempt can exchange a code once, including across server instances. */
export async function beginBrowserOAuth(db: GraphClient, binding: PendingBinding, requestId: string, now: number, verifierHash: string): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(
    `MATCH (p:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource})
     WHERE p.expires_at > $now AND p.state = 'login' AND p.callback_hash IS NULL
     SET p.callback_hash = $verifier, p.callback_used = false RETURN true AS ok`,
    { ...pendingParams(binding, requestId, now), verifier: verifierHash }, "starting browser OAuth");
  return rows[0]?.ok === true;
}
export async function claimBrowserOAuth(db: GraphClient, binding: PendingBinding, requestId: string, now: number, verifierHash: string): Promise<boolean> {
  const rows = await db.query<{ ok: boolean }>(
    `MATCH (p:OAuthPending {request_hash: $hash, owner_id: $owner, resource: $resource})
     WHERE p.expires_at > $now AND p.state = 'login' AND p.callback_hash = $verifier AND p.callback_used = false
     SET p.callback_used = true RETURN true AS ok`,
    { ...pendingParams(binding, requestId, now), verifier: verifierHash }, "claiming browser OAuth callback");
  return rows[0]?.ok === true;
}
