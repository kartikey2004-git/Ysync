import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // schema round-trip tests test/ ke andar hi hain
    include: ["test/**/*.test.ts"],
  },
});
