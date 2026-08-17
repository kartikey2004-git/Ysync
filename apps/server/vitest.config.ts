import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // bumped from vitest's 5s default — the Redis/Postgres integration
    // tests can be genuinely slower than that, especially cold
    testTimeout: 10000,
  },
});
