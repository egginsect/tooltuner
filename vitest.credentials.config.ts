import { defineConfig } from "vitest/config";

// Explicit, disposable PostgreSQL only. Never runs with the ordinary unit/integration commands.
export default defineConfig({ test: { include: ["tests/credentials/**/*.test.ts"], environment: "node", testTimeout: 15000, fileParallelism: false } });
