import { afterEach, describe, expect, test } from "vitest";
import { resolveRequiredUrl } from "../src/config.js";

describe("resolveRequiredUrl", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test("returns the provided value when set", () => {
    expect(resolveRequiredUrl("REDIS_URL", "redis://real-host:6379", "redis://localhost:6379")).toBe(
      "redis://real-host:6379",
    );
  });

  test("falls back to the dev default when unset and not in production", () => {
    process.env.NODE_ENV = "development";
    expect(resolveRequiredUrl("REDIS_URL", undefined, "redis://localhost:6379")).toBe("redis://localhost:6379");
  });

  test("throws instead of falling back when unset in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => resolveRequiredUrl("DATABASE_URL", undefined, "postgresql://postgres:postgres@localhost:5432/ysync")).toThrow(
      /DATABASE_URL is required in production/,
    );
  });
});
