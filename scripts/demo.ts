/** Local SDK evidence only. No hosted-client, coding-runner or deployment receipt is simulated. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFixtureServer, REPRODUCTION } from "../fixtures/server.js";
import { seedConfiguredFixtures } from "../fixtures/registry.js";
import { loadConfig } from "../src/config.js";
import { Grant, newId, type ToolGroup } from "../src/contracts.js";
import { GraphClient } from "../src/db/client.js";
import { insertGrant } from "../src/db/auth.js";
import { getCall, getPacket } from "../src/db/evidence.js";
import { createRuntime } from "../src/runtime.js";

type Json = Record<string, unknown>;
const form = (body: Record<string, string>) => ({ method: "POST", redirect: "manual" as const,
  headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

/** An isolated real local exercise. Deletes only the UUID graph created by this invocation. */
export async function runLocalDemo() {
  const graph = `runtime_${randomUUID().replaceAll("-", "")}`;
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", env: { PATH: process.env.PATH } }).trim().length > 0;
  const fixture = await startFixtureServer();
  const server = createServer();
  const clients: Client[] = [];
  let db: GraphClient | undefined;
  const checks: string[] = [];
  try {
    db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph,
      username: process.env.FALKORDB_USERNAME, password: process.env.FALKORDB_PASSWORD });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const ownerSecret = randomBytes(32).toString("base64url");
    const config = loadConfig({ FLYWHEEL_PUBLIC_ORIGIN: origin, FLYWHEEL_OWNER_SECRET: ownerSecret, FALKORDB_GRAPH: graph });
    let runtime = await createRuntime({ config, db });
    server.on("request", runtime.app);
    const seeded = await seedConfiguredFixtures(db, { owner_id: "owner", baseUrl: fixture.baseUrl,
      source: { repo_id: "tooltuner/mcp-flywheel-oss", commit_sha: sourceCommit }, initializeStable: true });
    assert.equal(seeded.versions.length, 2);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${origin}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
    checks.push("health and unauthenticated MCP challenge");

    async function connect(groups: ToolGroup[], scope: Json = {}, owner = "owner") {
      const grant = Grant.parse({ schema_version: 1, grant_id: newId("grant"), owner_id: owner,
        label: `local-sdk-${groups.join("-")}`, groups, allow: { apps: ["textkit", "catalog"], tools: {}, repos: ["tooltuner/mcp-flywheel-oss"] },
        scope, created_at: new Date().toISOString(), revoked_at: null });
      await insertGrant(db!, grant);
      const registration = await fetch(`${origin}/register`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: grant.label, redirect_uris: ["http://localhost:9/callback"], token_endpoint_auth_method: "none" }) });
      assert.equal(registration.status, 201);
      const { client_id: clientId } = await registration.json() as { client_id: string };
      const verifier = randomBytes(32).toString("base64url");
      const authorize = new URL(`${origin}/authorize`);
      authorize.search = new URLSearchParams({ response_type: "code", client_id: clientId,
        redirect_uri: "http://localhost:9/callback", resource: `${origin}/mcp`, state: "local-demo",
        code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
      const authorization = await fetch(authorize, { redirect: "manual" });
      assert.equal(authorization.status, 200);
      const page = await authorization.text();
      const requestId = /name="request_id" value="([^"]+)"/.exec(page)?.[1];
      assert(requestId, "Consent page must provide a request id");
      assert(!page.includes(grant.grant_id), "Unauthenticated login must not disclose grant identifiers");
      assert(!page.includes('name="grant_id"'), "Grant selection must require owner authentication");
      const login = await fetch(`${origin}/oauth/owner-login`, form({ request_id: requestId, owner_secret: ownerSecret }));
      assert.equal(login.status, 200);
      const selectionPage = await login.text();
      assert(selectionPage.includes(grant.grant_id), "Authenticated owner must be able to choose the intended grant");
      assert(!selectionPage.includes(ownerSecret), "Owner secret must not be rendered back into the form");
      const selectionToken = /name="selection_token" value="([^"]+)"/.exec(selectionPage)?.[1];
      assert(selectionToken, "Authenticated consent must contain a request-bound selection capability");
      const consent = await fetch(`${origin}/oauth/consent`, form({ request_id: requestId, grant_id: grant.grant_id,
        selection_token: selectionToken, decision: "approve" }));
      assert.equal(consent.status, 302);
      const callback = new URL(consent.headers.get("location")!);
      assert.equal(callback.searchParams.get("state"), "local-demo");
      const tokenResponse = await fetch(`${origin}/token`, form({ grant_type: "authorization_code", client_id: clientId,
        code: callback.searchParams.get("code")!, code_verifier: verifier, redirect_uri: "http://localhost:9/callback", resource: `${origin}/mcp` }));
      assert.equal(tokenResponse.status, 200);
      const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
      const client = new Client({ name: grant.label, version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      }));
      clients.push(client);
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["describe", "dispatch", "list_apps"]);
      assert.equal(tools.tools.find((tool) => tool.name === "dispatch")?.annotations?.readOnlyHint, false);
      return { client, grant, clientId, tokens };
    }
    const call = async (client: Client, name: string, args: Json): Promise<Json> => {
      const reply = await client.callTool({ name, arguments: args });
      assert(reply.structuredContent, "MCP result must include structuredContent");
      return reply.structuredContent as Json;
    };
    const dispatch = (client: Client, application: string, tool: string, args: Json, key?: string) =>
      call(client, "dispatch", { application, tool, args, ...(key ? { idempotency_key: key } : {}) });
    const denied = async (client: Client, tool: string, args: Json = {}) => {
      const response = await dispatch(client, "flywheel", tool, args);
      assert.equal((response.error as Json)?.code, "forbidden", `${tool} must be denied by policy`);
    };
    const user = await connect(["user"]);
    const development = await connect(["development"]);
    const management = await connect(["management"]);
    const union = await connect(["user", "development", "management"]);
    const catalog = await call(user.client, "list_apps", {});
    assert.deepEqual((catalog.apps as Json[]).map((app) => app.application).sort(), ["catalog", "flywheel", "textkit"]);
    const userTools = await call(user.client, "describe", { application: "flywheel" });
    assert.deepEqual((userTools.tools as Json[]).map((tool) => tool.name), ["report_feedback"]);
    const devTools = await call(development.client, "describe", { application: "flywheel" });
    assert.deepEqual((devTools.tools as Json[]).map((tool) => tool.name).sort(), ["get_context", "get_evidence"]);
    const managedTools = await call(management.client, "describe", { application: "flywheel" });
    assert((managedTools.tools as Json[]).some((tool) => tool.name === "create_packet"));
    const unionTools = await call(union.client, "describe", { application: "flywheel" });
    for (const tool of [...userTools.tools as Json[], ...devTools.tools as Json[], ...managedTools.tools as Json[]]) {
      assert((unionTools.tools as Json[]).some((candidate) => candidate.name === tool.name));
    }
    const baseline = await dispatch(user.client, "textkit", "word_count", { ...REPRODUCTION.args }, "local-baseline");
    assert.equal(baseline.outcome, "success");
    assert.equal(((baseline.result as Json).structuredContent as Json).count, 2);
    const pinned = await call(user.client, "dispatch", { application: "textkit", version: "v1", tool: "word_count", args: { ...REPRODUCTION.args } });
    assert.equal(pinned.resolved_version, baseline.resolved_version);
    const missingVersion = await call(user.client, "dispatch", { application: "textkit", version: "not-registered", tool: "word_count", args: { ...REPRODUCTION.args } });
    assert.equal((missingVersion.error as Json).code, "version_unavailable");
    const replay = await dispatch(user.client, "textkit", "word_count", { ...REPRODUCTION.args }, "local-baseline");
    assert.equal(replay.call_ref, baseline.call_ref);
    const feedback = await dispatch(user.client, "flywheel", "report_feedback", { call_refs: [baseline.call_ref], signal: "negative",
      observed: "2", expected: "3", text: "Whitespace reproduction in local SDK smoke.", idempotency_key: "local-feedback" });
    assert.equal(feedback.outcome, "success");
    const feedbackResult = feedback.result as Json;
    assert.equal(feedbackResult.durable, true);
    const packet = await dispatch(management.client, "flywheel", "create_packet", { call_refs: [baseline.call_ref],
      feedback_ids: [feedbackResult.feedback_id], change_summary: "Count all whitespace-separated words" });
    assert.equal(packet.outcome, "success");
    const packetResult = packet.result as Json;
    assert.deepEqual(Object.keys(packetResult).sort(), ["digest", "missing_refs", "packet_id"]);
    const evidence = await dispatch(development.client, "flywheel", "get_evidence", { refs: [baseline.call_ref] });
    assert.equal(evidence.outcome, "success");
    assert.equal(((evidence.result as Json).items as Json[]).length, 1);
    await denied(user.client, "get_evidence", { refs: [baseline.call_ref] });
    await denied(user.client, "start_job");
    for (const tool of ["create_packet", "start_job", "register_preview"]) await denied(development.client, tool);
    await denied(management.client, "get_evidence", { refs: [baseline.call_ref] });
    for (const session of [user, development, management, union]) for (const tool of ["merge", "activate", "rollback"]) await denied(session.client, tool);
    checks.push("four real local OAuth grants, filtered inner catalogs and direct-dispatch denials", "real fixture call, idempotent replay, durable feedback, packet ACK and evidence read");
    const scoped = await connect(["development"], { packet_id: packetResult.packet_id });
    const outsidePacket = await dispatch(user.client, "textkit", "word_count", { text: "Outside the frozen packet" });
    const nonexistent = newId("call");
    const scopedRead = await dispatch(scoped.client, "flywheel", "get_evidence", { refs: [baseline.call_ref, packetResult.packet_id, outsidePacket.call_ref, nonexistent] });
    assert.equal(scopedRead.outcome, "success");
    assert.deepEqual(((scopedRead.result as Json).missing_refs as string[]).sort(), [outsidePacket.call_ref, nonexistent].sort());
    assert.equal(((scopedRead.result as Json).items as Json[]).length, 2);
    const refreshed = await fetch(`${origin}/token`, form({ grant_type: "refresh_token", client_id: user.clientId,
      refresh_token: user.tokens.refresh_token, resource: `${origin}/mcp` }));
    assert.equal(refreshed.status, 200);
    checks.push("packet-scoped development read and OAuth refresh");
    const second = await dispatch(user.client, "catalog", "capabilities", {});
    assert.equal(second.outcome, "success");
    await db.close();
    assert.equal((await fetch(`${origin}/healthz`)).status, 503);
    db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph,
      username: process.env.FALKORDB_USERNAME, password: process.env.FALKORDB_PASSWORD });
    runtime = await createRuntime({ config, db });
    server.removeAllListeners("request"); server.on("request", runtime.app);
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    assert.equal((await getCall(db, "owner", baseline.call_ref as string))?.outcome, "success");
    assert.equal((await getPacket(db, "owner", packetResult.packet_id as string))?.digest, packetResult.digest);
    const reconnect = await call(development.client, "list_apps", {});
    assert((reconnect.apps as Json[]).some((app) => app.application === "flywheel"));
    runtime.lifecycle.closeAdmission();
    assert.equal((await fetch(`${origin}/healthz`)).status, 503);
    checks.push("second independent app", "storage disconnect returns 503; fresh composition reads persisted records and accepts existing token", "draining health returns 503");
    return { recorded_at: new Date().toISOString(), source_commit: sourceCommit, dirty_checkout: dirty,
      evidence_type: "real-local-sdk-and-falkordb", graph, graph_cleanup: "deleted after run", checks,
      refs: { call: baseline.call_ref, feedback: feedbackResult.feedback_id, packet: packetResult.packet_id },
      pending: ["fixed public HTTPS", "ChatGPT and Claude consent/calls/refresh", "owner upstream account linking", "real coding CLI isolation and start receipt", "existing-project Vercel verified preview", "real pinned preview comparison", "separately authorized human decisions"] };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    await fixture.close();
    if (db) { try { await db.dropGraph(); } finally { await db.close(); } }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLocalDemo().then((receipt) => process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)).catch((error: unknown) => {
    process.stderr.write(`Local demo failed: ${error instanceof Error ? error.message : "Unknown error"}\n`);
    process.exitCode = 1;
  });
}
