import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("tracing", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_TRACES_EXPORTER;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("imports without error when no OTEL endpoint is configured", async () => {
    const mod = await import("../src/tracing.js");
    expect(mod.initTracing).toBeTypeOf("function");
    expect(mod.trace).toBeDefined();
  });

  it("initTracing does not throw when no OTEL_EXPORTER_OTLP_ENDPOINT is set", async () => {
    const { initTracing } = await import("../src/tracing.js");
    expect(() => initTracing()).not.toThrow();
  });

  it("reports tracing as not enabled when no endpoint is configured", async () => {
    const { initTracing, isTracingEnabled } = await import("../src/tracing.js");
    initTracing();
    expect(isTracingEnabled()).toBe(false);
  });
});
