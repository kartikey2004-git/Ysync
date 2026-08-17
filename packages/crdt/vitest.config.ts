import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // unit tests aur fast-check wala property test dono test/ ke andar hi hain
    include: ["test/**/*.test.ts"],
  },
});
