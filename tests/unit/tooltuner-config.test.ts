import { describe, expect, it } from "vitest";
import { credentialPostgresSecrets, loadConfig, resolveToolTunerEnvironment } from "../../src/config.js";

const hosted = { TOOLTUNER_RUNTIME_MODE: "hosted", FALKORDB_URL: "rediss://graph.example:6379", FALKORDB_PASSWORD: "synthetic", TOOLTUNER_OWNER_SECRET: "synthetic-owner-secret-32-characters" };
const vercel = { ...hosted, VERCEL: "1", VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "tooltuner-git-feature.vercel.app", VERCEL_URL: "tooltuner-deployment.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "tooltuner.example" };
const suffixes = ["RUNTIME_MODE", "PUBLIC_ORIGIN", "AUTH_MODE", "OWNER_ID", "OWNER_SECRET", "CREDENTIAL_POSTGRES_URL", "CREDENTIAL_KEYS", "CREDENTIAL_ACTIVE_KEY_VERSION", "CREDENTIAL_POSTGRES_CONNECTION_MODE"];

describe("ToolTuner configuration migration", () => {
  it.each(suffixes)("resolves canonical and legacy %s without ambiguity or mutation", (suffix) => {
    const name = `TOOLTUNER_${suffix}`, old = `FLYWHEEL_${suffix}`;
    for (const env of [{ [name]: "value" }, { [old]: "value" }, { [name]: "value", [old]: "value" }, { [name]: "  ", [old]: "value" }, { [name]: "value", [old]: "" }]) {
      const before = { ...env };
      expect(resolveToolTunerEnvironment(env)[name]).toBe("value");
      expect(env).toEqual(before);
    }
    expect(resolveToolTunerEnvironment({ [name]: " ", [old]: "" })[name]).toBeUndefined();
    expect(() => resolveToolTunerEnvironment({ [name]: "secret-one", [old]: "secret-two" })).toThrow(/conflict/);
    try { resolveToolTunerEnvironment({ [name]: "secret-one", [old]: "secret-two" }); } catch (error) {
      expect(String(error)).not.toMatch(/secret-one|secret-two/);
    }
  });
  it("keeps legacy configuration behavior and rejects mixed auth modes", () => {
    expect(loadConfig({ FLYWHEEL_OWNER_ID: "legacy-owner", FLYWHEEL_PUBLIC_ORIGIN: "https://legacy.example" }).owner.id).toBe("legacy-owner");
    expect(() => loadConfig({ TOOLTUNER_AUTH_MODE: "supabase", FLYWHEEL_AUTH_MODE: "owner-secret" })).toThrow(/conflict/);
    expect(() => loadConfig({ TOOLTUNER_AUTH_MODE: "supabase", SUPABASE_URL: "https://auth.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", TOOLTUNER_PUBLIC_ORIGIN: "https://gateway.example", FLYWHEEL_OWNER_SECRET: "synthetic-owner-secret" })).toThrow(/Do not configure/);
  });
  it("uses the same alias checks for credential material without exposing values", () => {
    const keys = JSON.stringify({ v1: Buffer.alloc(32, 1).toString("base64") });
    const env = { FLYWHEEL_CREDENTIAL_KEYS: keys, FLYWHEEL_CREDENTIAL_POSTGRES_URL: "postgresql://synthetic.example/db" };
    expect(credentialPostgresSecrets(env).keys.v1).toHaveLength(32);
    expect(credentialPostgresSecrets({ TOOLTUNER_CREDENTIAL_KEYS: keys, TOOLTUNER_CREDENTIAL_POSTGRES_URL: env.FLYWHEEL_CREDENTIAL_POSTGRES_URL })).toEqual(credentialPostgresSecrets(env));
    expect(() => credentialPostgresSecrets({ ...env, TOOLTUNER_CREDENTIAL_KEYS: "different-secret" })).toThrow(/conflict/);
  });
});

describe("trusted deployment origin", () => {
  it("chooses production metadata only in production and stable branch metadata in preview", () => {
    expect(loadConfig({ ...vercel, VERCEL_ENV: "production" }).publicOrigin).toBe("https://tooltuner.example");
    const config = loadConfig(vercel);
    expect(config.publicOrigin).toBe("https://tooltuner-git-feature.vercel.app");
    expect(config.oauth).toEqual({ issuer: "https://tooltuner-git-feature.vercel.app/", resource: "https://tooltuner-git-feature.vercel.app/mcp" });
    expect(loadConfig({ ...vercel, VERCEL_BRANCH_URL: "" }).publicOrigin).toBe("https://tooltuner-deployment.vercel.app");
    expect(() => loadConfig({ ...vercel, VERCEL_BRANCH_URL: "", VERCEL_URL: "" })).toThrow(/PUBLIC_ORIGIN/);
  });
  it("honors explicit origins, but does not hide conflicting aliases or mismatched OAuth metadata", () => {
    expect(loadConfig({ ...vercel, TOOLTUNER_PUBLIC_ORIGIN: "https://custom.example", VERCEL_BRANCH_URL: "bad/path" }).publicOrigin).toBe("https://custom.example");
    expect(loadConfig({ ...vercel, FLYWHEEL_PUBLIC_ORIGIN: "https://legacy.example" }).publicOrigin).toBe("https://legacy.example");
    expect(() => loadConfig({ ...vercel, TOOLTUNER_PUBLIC_ORIGIN: "https://one.example", FLYWHEEL_PUBLIC_ORIGIN: "https://two.example" })).toThrow(/conflict/);
    expect(() => loadConfig({ ...vercel, OAUTH_ISSUER: "https://tooltuner.example" })).toThrow(/OAUTH_ISSUER/);
    expect(() => loadConfig({ ...vercel, OAUTH_RESOURCE: "https://tooltuner.example/mcp" })).toThrow(/OAUTH_RESOURCE/);
  });
  it.each(["https://gateway.example", "gateway.example/path", "gateway.example?x=1", "gateway.example#fragment", "user@gateway.example", "gateway.example:443", " gateway.example", "gateway.example\n", "gateway.example.", "127.0.0.1", "[::1]", "a.localhost", "a..example", "-a.example", "a_.example", "a\\example.com"])("rejects malformed metadata %j without fallback", (hostname) => {
    expect(() => loadConfig({ ...vercel, VERCEL_BRANCH_URL: hostname })).toThrow(/DNS hostname/);
  });
  it("requires explicit origins outside hosted Vercel and never changes auth mode", () => {
    expect(() => loadConfig({ ...vercel, VERCEL: undefined })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ ...vercel, VERCEL_ENV: "development" })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ ...vercel, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "" })).toThrow(/PUBLIC_ORIGIN/);
    expect(loadConfig({ ...vercel, TOOLTUNER_RUNTIME_MODE: "local" }).publicOrigin).toBeUndefined();
    expect(loadConfig(vercel).auth.mode).toBe("owner-secret");
  });
});
