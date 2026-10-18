import { defineConfig } from "vitest/config";

// Unit tests only: no database, no network. Integration tests use vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
