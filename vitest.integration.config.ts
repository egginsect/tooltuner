import { defineConfig } from "vitest/config";

// Integration tests need a running FalkorDB (see docker-compose.yml) reachable at FALKORDB_URL.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
