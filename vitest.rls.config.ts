import { defineConfig } from "vitest/config";
// A fresh disposable database is required; this suite creates test-only roles.
export default defineConfig({ test: { include: ["tests/rls/**/*.test.ts"], environment: "node", testTimeout: 15000, fileParallelism: false } });
