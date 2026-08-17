import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // yahan tests apne code ke paas hi rakhte hain, alag test/ folder mein nahi
    include: ["src/**/*.test.ts"],
  },
});
