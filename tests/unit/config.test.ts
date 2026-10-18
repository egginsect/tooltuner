import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../../src/config.js";
import { configReadiness, formatReadiness } from "../../src/readiness.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config.http).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(config.database).toMatchObject({ url: "redis://127.0.0.1:6379", graph: "flywheel" });
    expect(config.publicOrigin).toBeUndefined();
    expect(config.oauth.allowedRedirectUris).toEqual([]);
    expect(config.logLevel).toBe("info");
  });

  it("treats empty strings (as listed in .env.example) as unset", () => {
    const config = loadConfig({ PORT: "", FLYWHEEL_PUBLIC_ORIGIN: "", OAUTH_ALLOWED_REDIRECT_URIS: "", VERCEL_TOKEN: "", FALKORDB_PASSWORD: "" });
    expect(config.http.port).toBe(8787);
    expect(config.publicOrigin).toBeUndefined();
    expect(config.vercel.tokenPresent).toBe(false);
  });

  it("parses explicit values and derives the OAuth resource from the public origin", () => {
    const config = loadConfig({
      PORT: "9100",
      FALKORDB_GRAPH: "demo_graph",
      FLYWHEEL_PUBLIC_ORIGIN: "https://flywheel.example.dev",
      OAUTH_ALLOWED_REDIRECT_URIS: "https://client.example/cb, https://other.example/cb",
    });
    expect(config.http.port).toBe(9100);
    expect(config.database.graph).toBe("demo_graph");
    expect(config.oauth.resource).toBe("https://flywheel.example.dev/mcp");
    expect(config.oauth.allowedRedirectUris).toEqual(["https://client.example/cb", "https://other.example/cb"]);
  });

  it("reports every invalid value in one descriptive error", () => {
    const attempt = () => loadConfig({ PORT: "70000", FALKORDB_URL: "redis://user:pass@host:6379", FALKORDB_GRAPH: "bad graph", FLYWHEEL_PUBLIC_ORIGIN: "http://flywheel.example.dev/path" });
    expect(attempt).toThrow(ConfigError);
    try {
      attempt();
    } catch (error) {
      const issues = (error as ConfigError).issues.join("\n");
      expect(issues).toContain("PORT");
      expect(issues).toContain("FALKORDB_URL");
      expect(issues).toContain("FALKORDB_GRAPH");
      expect(issues).toContain("FLYWHEEL_PUBLIC_ORIGIN");
    }
  });

  it("rejects an OAuth resource on a different origin than the fixed public origin", () => {
    expect(() => loadConfig({ FLYWHEEL_PUBLIC_ORIGIN: "https://flywheel.example.dev", OAUTH_RESOURCE: "https://other.example.dev/mcp" })).toThrow(/must equal FLYWHEEL_PUBLIC_ORIGIN/);
    expect(() => loadConfig({ OAUTH_ISSUER: "https://flywheel.example.dev" })).toThrow(/FLYWHEEL_PUBLIC_ORIGIN/);
  });

  it("allows plain http only for localhost origins", () => {
    expect(loadConfig({ FLYWHEEL_PUBLIC_ORIGIN: "http://localhost:8787" }).publicOrigin).toBe("http://localhost:8787");
    expect(() => loadConfig({ FLYWHEEL_PUBLIC_ORIGIN: "http://flywheel.example.dev" })).toThrow(/https/);
  });
});

describe("secret handling", () => {
  const env = { FALKORDB_PASSWORD: "super-secret-db-password", VERCEL_TOKEN: "super-secret-vercel-token", OAUTH_SIGNING_KEY_REF: "file:/etc/keys/signing.pem" };

  it("never puts credential values into the log-safe description or the readiness report", () => {
    const config = loadConfig(env);
    const rendered = JSON.stringify(describeConfig(config)) + formatReadiness(configReadiness(config)).join("\n");
    expect(rendered).not.toContain("super-secret-db-password");
    expect(rendered).not.toContain("super-secret-vercel-token");
    expect(config.vercel.tokenPresent).toBe(true);
  });

  it("does not store the Vercel token in the config object at all", () => {
    expect(JSON.stringify(loadConfig(env))).not.toContain("super-secret-vercel-token");
  });
});

describe("configReadiness", () => {
  it("reports optional features as not_configured and never as ready without verification", () => {
    const items = configReadiness(loadConfig({}));
    expect(items.map((item) => item.name)).toEqual(["public_origin", "flywheel_oauth", "upstream_linking", "fixtures", "runner", "vercel"]);
    expect(items.every((item) => item.status === "not_configured")).toBe(true);
    expect(items.every((item) => item.status !== "ready")).toBe(true);
  });

  it("marks configured features unverified, not ready", () => {
    const items = configReadiness(
      loadConfig({
        FLYWHEEL_PUBLIC_ORIGIN: "https://flywheel.example.dev",
        OAUTH_ISSUER: "https://flywheel.example.dev",
        OAUTH_ALLOWED_REDIRECT_URIS: "https://client.example/cb",
        OAUTH_SIGNING_KEY_REF: "file:/etc/keys/signing.pem",
      }),
    );
    const byName = Object.fromEntries(items.map((item) => [item.name, item.status]));
    expect(byName["public_origin"]).toBe("unverified");
    expect(byName["flywheel_oauth"]).toBe("unverified");
  });
});
