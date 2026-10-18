import { randomUUID } from "node:crypto";
import type { Response } from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { GraphClient } from "../../src/db/client.js";
import { bootstrapSchema, INDEX_SPECS } from "../../src/db/schema.js";
import * as store from "../../src/db/auth.js";
import { FlywheelOAuthProvider } from "../../src/gateway/oauth/provider.js";
import { newId, type Grant } from "../../src/contracts.js";

let db: GraphClient;
const binding = { ownerId: "owner", resource: "https://gateway.example/mcp" };
const client = { client_id: "synthetic-client", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" as const };
const options = { ...binding, ownerSecret: "synthetic-owner-secret" };
const grant: Grant = { schema_version: 1, grant_id: newId("grant"), owner_id: "owner", label: "Test grant", groups: ["user"],
  allow: { apps: ["example-app"], tools: { "example-app": ["read"] }, repos: [] }, scope: {}, created_at: new Date().toISOString(), revoked_at: null };
beforeAll(async () => {
  db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph: `pending_${randomUUID().replaceAll("-", "")}` });
  await bootstrapSchema(db, INDEX_SPECS);
  await store.insertGrant(db, grant);
});
afterAll(async () => { if (db) { try { await db.dropGraph(); } finally { await db.close(); } } });

async function authorize(provider: FlywheelOAuthProvider) {
  let page = "";
  const response = { status: () => response, set: () => response, send: (value: string) => { page = value; return response; } };
  await provider.authorize(client, { redirectUri: client.redirect_uris[0]!, codeChallenge: "a".repeat(43), state: "synthetic-state" }, response as unknown as Response);
  return /name="request_id" value="([^"]+)"/.exec(page)![1]!;
}

describe("durable browser authorization", () => {
  it("survives provider replacement and consumes concurrent login and approval exactly once", async () => {
    const first = new FlywheelOAuthProvider({ db, ...options });
    const id = await authorize(first);
    const instances = [new FlywheelOAuthProvider({ db, ...options }), new FlywheelOAuthProvider({ db, ...options })];
    const logins = await Promise.all(instances.map((p) => p.authenticateOwner({ requestId: id, ownerSecret: options.ownerSecret })));
    const success = logins.filter((value) => "html" in value);
    expect(success).toHaveLength(1);
    const selection = /name="selection_token" value="([^"]+)"/.exec(success[0]!.html)![1]!;
    const approvals = await Promise.all(instances.map((p) => p.completeConsent({ requestId: id, selectionToken: selection, grantId: grant.grant_id, approve: true })));
    expect(approvals.filter((value) => "redirectTo" in value)).toHaveLength(1);
    expect(await store.readPendingAuthorization(db, binding, id, Date.now())).toBeNull();
    const rows = await db.roQuery<{ request_hash: string; doc: string }>("MATCH (p:OAuthPending) RETURN p.request_hash AS request_hash, p.doc AS doc");
    expect(rows[0]?.request_hash).toBe(store.hashSecret(id));
    expect(rows[0]?.doc).not.toContain(selection);
    expect(rows[0]?.doc).not.toContain(options.ownerSecret);
  });

  it("isolates owners/resources and enforces TTL without a cleanup job", async () => {
    const id = randomUUID();
    expect(await store.insertPendingAuthorization(db, binding, id, "{}", 2000, 1000)).toBe(true);
    expect(await store.claimPendingLogin(db, { ...binding, ownerId: "other" }, id, 1001)).toBeNull();
    expect(await store.claimPendingLogin(db, { ...binding, resource: "https://other.example/mcp" }, id, 1001)).toBeNull();
    expect(await store.readPendingAuthorization(db, binding, id, 2000)).toBeNull();
    expect(await store.claimPendingLogin(db, binding, id, 2000)).toBeNull();
    expect(await store.consumePendingAuthorization(db, binding, id, 2000, false, "")).toBeNull();
  });

  it("rejects a mismatched or expired selection and prevents duplicate completion", async () => {
    const id = randomUUID();
    await store.insertPendingAuthorization(db, binding, id, "{}", 9000, 3000);
    expect(await store.claimPendingLogin(db, binding, id, 3001)).toBe("{}");
    expect(await store.finishPendingLogin(db, binding, id, 3002, "{}", "hash", 4000)).toBe(true);
    expect(await store.finishPendingLogin(db, binding, id, 3003, "{}", "other", 5000)).toBe(false);
    expect(await store.consumePendingAuthorization(db, binding, id, 3004, true, "wrong")).toBeNull();
    expect(await store.consumePendingAuthorization(db, binding, id, 4000, true, "hash")).toBeNull();
    expect(await store.consumePendingAuthorization(db, binding, id, 4001, false, "")).toBe("{}");
    expect(await store.consumePendingAuthorization(db, binding, id, 4002, false, "")).toBeNull();
  });
  it("atomically bounds active requests and cleans expired records", async () => {
    const scope = { ...binding, resource: "https://capacity.example/mcp" };
    const now = Date.now();
    await db.query(`UNWIND range(1, 999) AS n CREATE (:OAuthPending {request_hash: 'capacity-' + toString(n),
      owner_id: $owner, resource: $resource, expires_at: $expires, state: 'login', doc: '{}'})`,
      { owner: scope.ownerId, resource: scope.resource, expires: now + 10000 });
    const created = await Promise.all([randomUUID(), randomUUID()].map((id) =>
      store.insertPendingAuthorization(db, scope, id, "{}", now + 10000, now)));
    expect(created.filter(Boolean)).toHaveLength(1);
    expect(await store.insertPendingAuthorization(db, scope, randomUUID(), "{}", now + 20000, now + 10000)).toBe(true);
    const rows = await db.roQuery<{ total: number }>("MATCH (p:OAuthPending {resource: $resource}) RETURN count(p) AS total", { resource: scope.resource });
    expect(rows[0]?.total).toBe(1);
  });

});
