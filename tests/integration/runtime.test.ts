import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runLocalDemo } from "../../scripts/demo.js";
import { GraphClient } from "../../src/db/client.js";
import { loadConfig } from "../../src/config.js";
import { createRuntime } from "../../src/runtime.js";
import { Grant, Application, Version, COMPLETE, provenanceOf, newId, canonicalDigest, type OperationContext } from "../../src/contracts.js";
import { insertGrant, getGrant } from "../../src/db/auth.js";
import { getCall } from "../../src/db/evidence.js";
import { insertApplication, insertVersion, versionDigest } from "../../src/db/registry.js";
import { startFixtureServer, REPRODUCTION } from "../../fixtures/server.js";
import { seedConfiguredFixtures } from "../../fixtures/registry.js";
import { readUpstreamCatalog } from "../../src/gateway/upstream.js";
import { startProtectedFixture } from "../../fixtures/protected.js";

it("composes the production OAuth/gateway/evidence services against real SDK fixtures and FalkorDB", async () => {
  const receipt = await runLocalDemo();
  expect(receipt.evidence_type).toBe("real-local-sdk-and-falkordb");
  expect(receipt.checks).toContain("four real local OAuth grants, filtered inner catalogs and direct-dispatch denials");
  expect(receipt.checks).toContain("storage disconnect returns 503; fresh composition reads persisted records and accepts existing token");
  expect(receipt.refs.call).toMatch(/^call_/);
  expect(receipt.refs.feedback).toMatch(/^fb_/);
  expect(receipt.refs.packet).toMatch(/^pkt_/);
  expect(receipt.transcript).toMatchObject({ stable: 2, pinned_candidate: 3, stable_after_comparison: 2,
    after_owner_activation: 3, after_owner_rollback: 2, same_client: true, comparison: ["fail", "pass"] });
  expect(receipt.checks).toContain("production service process stops and restarts; existing tokens dispatch and read original evidence after both starts");
  expect(receipt.refs.activation).toMatch(/^dec_/);
  expect(receipt.refs.rollback).toMatch(/^dec_/);
  expect(receipt.checks).toContain("independent child process verifies persisted call, packet, comparison, stable pointer and owner decisions");
}, 60_000);

it("composes MANAGEMENT-only frozen trials without widening direct upstream or evidence access", async () => {
  const graph = `trial_runtime_${randomUUID().replaceAll("-", "")}`;
  const db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph });
  let executions = 0;
  const fixture = await startFixtureServer({ onCall: () => { executions++; } });
  try {
    const runtime = await createRuntime({ config: loadConfig({}), db, integrations: {
      experimentConfigs: [{ ref: "config:runtime-readonly-v1", fixtureStateRef: "fixture:pure-word-count-v1", maxVersions: 2,
        expectedOutput: { content: [{ type: "text", text: JSON.stringify(REPRODUCTION.expected) }], structuredContent: REPRODUCTION.expected } }],
    } });
    const seeded = await seedConfiguredFixtures(db, { owner_id: "owner", baseUrl: fixture.baseUrl,
      source: { repo_id: "runtime-fixture", commit_sha: "a".repeat(40) }, initializeStable: true });
    const baseline = seeded.versions.find((version) => version.application === "textkit")!;
    // This explicit test-only reference is never presented as a coding-job or Vercel receipt.
    const target = { ...baseline, version_id: newId("version"), label: "runtime-test-reference", parent_version_id: baseline.version_id,
      runtime_target: { ...baseline.runtime_target, url: `${fixture.baseUrl}/textkit/example-v2/mcp`, deployment_id: "local:runtime-reference" } };
    const tools = await readUpstreamCatalog(target);
    const content = { ...target, tools, schema_digest: canonicalDigest({ tools }) };
    const candidate = await insertVersion(db, { ...content, digest: versionDigest(content) });
    async function context(group: "user" | "management"): Promise<OperationContext> {
      const grant = Grant.parse({ schema_version: 1, owner_id: "owner", grant_id: newId("grant"), label: `runtime-${group}`, groups: [group],
        allow: { apps: ["textkit"], tools: { textkit: ["word_count"] }, repos: ["runtime-fixture"] }, created_at: new Date().toISOString() });
      await insertGrant(db, grant);
      return { grant, principal: { owner_id: "owner", grant_id: grant.grant_id, client_id: "runtime-test", subject: "runtime-test", session_id: "runtime-test" }, call_id: newId("call") };
    }
    const user = await context("user");
    const manager = await context("management");
    const originalGrant = structuredClone(manager.grant);
    const original = await runtime.core.dispatch(user, { application: "textkit", version: baseline.version_id, tool: "word_count", args: REPRODUCTION.args });
    const before = executions;
    const comparison = await runtime.core.dispatch(manager, { application: "flywheel", tool: "run_experiment", args: {
      application: "textkit", version_ids: [baseline.version_id, candidate.version_id], input_ref: original.call_ref,
      criterion_ref: "criterion:expected-output", config_ref: "config:runtime-readonly-v1", idempotency_key: "runtime-management-trial",
    } });
    expect(comparison.outcome).toBe("success");
    const result = comparison.result as { evaluation_id: string; state: string };
    expect(result.state).toBe("completed");
    expect(executions - before).toBe(2);
    const saved = await runtime.handlers.get_experiment(manager, { evaluation_id: result.evaluation_id });
    expect(saved.evaluation.results.map((row) => row.task_outcome)).toEqual(["fail", "pass"]);
    for (const row of saved.evaluation.results) expect((await getCall(db, "owner", row.call_ref!))?.grant_id).toBe(manager.grant.grant_id);
    await expect(runtime.core.dispatch(manager, { application: "textkit", version: baseline.version_id, tool: "word_count", args: REPRODUCTION.args }))
      .rejects.toMatchObject({ shape: { code: "forbidden" } });
    await expect(runtime.core.dispatch(manager, { application: "flywheel", tool: "get_evidence", args: { refs: [original.call_ref] } }))
      .rejects.toMatchObject({ shape: { code: "forbidden" } });
    expect(executions - before).toBe(2);
    expect(manager.grant).toEqual(originalGrant);
    expect(await getGrant(db, manager.grant.grant_id)).toEqual(originalGrant);
  } finally {
    await fixture.close();
    try { await db.dropGraph(); } finally { await db.close(); }
  }
}, 30_000);

it("links through the real owner CLI and resolves the exact protected upstream from runtime configuration", async () => {
  const graph = `link_runtime_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379";
  const db = await GraphClient.connect({ url: databaseUrl, graph });
  const fixture = await startProtectedFixture();
  const directory = await mkdtemp(path.join(tmpdir(), "flywheel-runtime-link-"));
  try {
    const secret = fixture.credential();
    const environment = { PATH: "/usr/bin:/bin", FALKORDB_URL: databaseUrl, FALKORDB_GRAPH: graph,
      UPSTREAM_RUNTIME_TEST: JSON.stringify(secret) };
    const linkFile = path.join(directory, "link.json");
    const runtimeFile = path.join(directory, "runtime.json");
    await writeFile(linkFile, JSON.stringify({ credentialStore: { kind: "environment" }, account: {
      auth_config_ref: "fixture:runtime-account", credential_ref: "env:UPSTREAM_RUNTIME_TEST", application: "textkit", repo_id: "runtime-protected",
      environment: "local", issuer: fixture.issuer, introspection_url: `${fixture.origin}/introspect`, scopes: ["fixture:read"],
    }, target: { commit_sha: "a".repeat(40), deployment_id: "deployment-a", url: secret.resource, resource: secret.resource, audience: secret.audience } }));
    const cli = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/cli/owner.ts", "account", "link", "--input", linkFile,
      "--subject", "synthetic-local-test-owner", "--mode", "existing"], { env: environment, timeout: 15_000 });
    expect(JSON.parse(cli.stdout)).toMatchObject({ linked: true, auth_config_ref: "fixture:runtime-account", environment: "local" });
    expect(cli.stdout + cli.stderr).not.toContain(secret.tokens.access_token);
    await writeFile(runtimeFile, JSON.stringify({ credentialStore: { kind: "environment" } }));
    const runtime = await createRuntime({ config: loadConfig({ RUNNER_CONFIG_PATH: runtimeFile }), db, environment });
    const metadata = { schema_version: 1 as const, owner_id: "owner", created_at: new Date().toISOString(), provenance: provenanceOf("seed", null), completeness: COMPLETE };
    await insertApplication(db, Application.parse({ ...metadata, application: "textkit", description: "Protected local integration fixture", kind: "upstream" }));
    const target = { owner_id: "owner", application: "textkit", version_id: newId("version"), source: { repo_id: "runtime-protected", commit_sha: "a".repeat(40) },
      runtime_target: { kind: "mcp_streamable_http" as const, url: secret.resource, deployment_id: "deployment-a", environment: "local" as const }, auth_config_ref: "fixture:runtime-account" };
    const tools = await readUpstreamCatalog(target, { resolveAuth: async () => ({ Authorization: `Bearer ${secret.tokens.access_token}` }) });
    const content = { ...metadata, ...target, label: "v1", parent_version_id: null, tools, schema_digest: canonicalDigest({ tools }),
      verified_provenance: { method: "owner_config", job_id: null, packet_id: null }, state: "ready",
      readiness: { deployment_ready: true, provenance_verified: true, schema_verified: true, auth_verified: true } };
    const parsed = Version.parse({ ...content, digest: canonicalDigest({}) });
    const version = await insertVersion(db, { ...parsed, digest: versionDigest(parsed) });
    const grant = Grant.parse({ schema_version: 1, owner_id: "owner", grant_id: newId("grant"), label: "protected-runtime-user", groups: ["user"],
      allow: { apps: ["textkit"], tools: {}, repos: ["runtime-protected"] }, created_at: new Date().toISOString() });
    await insertGrant(db, grant);
    const context = { grant, principal: { owner_id: "owner", grant_id: grant.grant_id, subject: "test", client_id: "test", session_id: "test" } };
    const response = await runtime.core.dispatch(context, { application: "textkit", version: version.version_id, tool: tools[0]!.name, args: { text: "runtime protected call" } });
    expect(response.outcome).toBe("success");
    expect(fixture.metrics.toolCalls).toBe(1);
  } finally {
    await fixture.close();
    try { await db.dropGraph(); } finally { await db.close(); await rm(directory, { recursive: true }); }
  }
}, 30_000);

it("boots the real process entrypoint, reports storage health and exits cleanly on SIGTERM", async () => {
  const graph = `process_${randomUUID().replaceAll("-", "")}`;
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No test port allocated");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(address.port), FALKORDB_GRAPH: graph,
      FALKORDB_URL: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379",
      ...(process.env.FALKORDB_USERNAME ? { FALKORDB_USERNAME: process.env.FALKORDB_USERNAME } : {}),
      ...(process.env.FALKORDB_PASSWORD ? { FALKORDB_PASSWORD: process.env.FALKORDB_PASSWORD } : {}) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  try {
    const deadline = Date.now() + 10_000;
    let healthy = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { healthy = (await fetch(`http://127.0.0.1:${address.port}/healthz`, { signal: AbortSignal.timeout(500) })).status === 200; }
      catch { /* Wait only for this test-owned process to bind and bootstrap. */ }
      if (healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(healthy).toBe(true);
    expect(logs).toContain("start_job is unavailable");
    expect(logs).toContain("no deployment will run");
    child.kill("SIGTERM");
    const exit = await Promise.race([exited, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Process did not drain after SIGTERM")), 5000); timer.unref();
    })]);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(logs).toContain("Shutdown complete");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    const db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph,
      username: process.env.FALKORDB_USERNAME, password: process.env.FALKORDB_PASSWORD });
    try { await db.dropGraph(); } finally { await db.close(); }
  }
}, 20_000);

it("keeps absent adapters unavailable and rejects privileged credentials in coding configuration", async () => {
  const graph = `boundary_${randomUUID().replaceAll("-", "")}`;
  const db = await GraphClient.connect({ url: process.env.FALKORDB_URL ?? "redis://127.0.0.1:6379", graph,
    username: process.env.FALKORDB_USERNAME, password: process.env.FALKORDB_PASSWORD });
  const root = await mkdtemp(path.join(tmpdir(), "flywheel-runtime-config-"));
  try {
    const config = loadConfig({ TOOLTUNER_OWNER_SECRET: "synthetic-owner-consent-secret" });
    const runtime = await createRuntime({ config, db });
    expect(runtime.provider).toBeUndefined();
    for (const operation of ["start_job", "register_preview", "run_experiment"] as const) expect(runtime.handlers[operation]).toBeUndefined();
    const runnerConfig = { id: "test", executable: "/usr/bin/node", args: [],
      environmentAllowlist: ["OPENAI_API_KEY"], writablePaths: ["src"], checks: [], timeoutMs: 1000, network: false };
    await expect(createRuntime({ config, db, integrations: { runnerConfigs: [{ ...runnerConfig,
      environment: { OPENAI_API_KEY: config.owner.secret! } }] } })).rejects.toThrow("cannot reuse owner, database or deployment credentials");
    for (const name of ["TOOLTUNER_CREDENTIAL_POSTGRES_URL", "TOOLTUNER_CREDENTIAL_KEYS", "FLYWHEEL_CREDENTIAL_POSTGRES_URL", "FLYWHEEL_CREDENTIAL_KEYS"]) {
      await expect(createRuntime({ config, db, environment: { [name]: "synthetic-custody-only-value" }, integrations: { runnerConfigs: [{ ...runnerConfig,
        environment: { OPENAI_API_KEY: "synthetic-custody-only-value" } }] } })).rejects.toThrow("cannot reuse owner, database or deployment credentials");
    }
    const file = path.join(root, "runtime.json");
    await writeFile(file, JSON.stringify({ runnerConfigs: [{ ...runnerConfig, environmentRefs: { OPENAI_API_KEY: "VERCEL_TOKEN" } }] }));
    const fromFile = loadConfig({ RUNNER_CONFIG_PATH: file });
    await expect(createRuntime({ config: fromFile, db, environment: { VERCEL_TOKEN: "synthetic-manager-only-value" } }))
      .rejects.toThrow("only independently provisioned runner credentials");
  } finally {
    try { await db.dropGraph(); } finally { await db.close(); await rm(root, { recursive: true }); }
  }
});
