import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tests live next to their source here, not in a separate test/ folder
    include: ["src/**/*.test.ts"],
  },
});
