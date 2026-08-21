import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // both the unit tests and the fast-check property test live under test/
    include: ["test/**/*.test.ts"],
  },
});
