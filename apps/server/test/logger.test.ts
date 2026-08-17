import { describe, expect, test } from "vitest";
import winston from "winston";
import Transport from "winston-transport";
import { createLogger, errorMeta, logger } from "../src/logger.js";

interface CapturedLog {
  level: string;
  message: string;
  [key: string]: unknown;
}

class MemoryTransport extends Transport {
  readonly logs: CapturedLog[] = [];

  override log(info: CapturedLog, callback: () => void): void {
    this.logs.push(info);
    callback();
  }
}

function loggerWithMemoryTransport(overrides: { level?: string } = {}) {
  const transport = new MemoryTransport();
  const testLogger = createLogger({
    level: overrides.level,
    format: winston.format.json(),
    transports: [transport],
  });
  return { logger: testLogger, logs: transport.logs };
}

describe("logger", () => {
  test("the default singleton logger initializes without throwing", () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  test("structured metadata is preserved on a log call", () => {
    const { logger: testLogger, logs } = loggerWithMemoryTransport();

    testLogger.info("operation persisted", { docId: "doc-1", replicaId: "alice", seq: 5, opIds: ["1@alice"] });

    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("operation persisted");
    expect(entry.docId).toBe("doc-1");
    expect(entry.replicaId).toBe("alice");
    expect(entry.seq).toBe(5);
    expect(entry.opIds).toEqual(["1@alice"]);
  });

  test("defaultMeta (service/environment/instanceId) is attached to every log", () => {
    const { logger: testLogger, logs } = loggerWithMemoryTransport();

    testLogger.warn("something worth noting");

    const entry = logs[0]!;
    expect(entry.service).toBe("ysync-server");
    expect(typeof entry.environment).toBe("string");
    expect(typeof entry.instanceId).toBe("string");
  });

  test("log level filters out lower-priority levels", () => {
    const { logger: testLogger, logs } = loggerWithMemoryTransport({ level: "warn" });

    testLogger.debug("noisy debug line");
    testLogger.info("routine info line");
    testLogger.warn("this should come through");

    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toBe("this should come through");
  });

  test("errorMeta preserves message/name/stack for a real Error", () => {
    const err = new Error("boom");
    const meta = errorMeta(err);

    expect(meta.message).toBe("boom");
    expect(meta.name).toBe("Error");
    expect(meta.stack).toContain("boom");
  });

  test("errorMeta safely stringifies a non-Error throw", () => {
    const meta = errorMeta("just a string reason");
    expect(meta.message).toBe("just a string reason");
    expect(meta.name).toBeUndefined();
    expect(meta.stack).toBeUndefined();
  });

  test("an error logged via errorMeta keeps its context alongside the stack", () => {
    const { logger: testLogger, logs } = loggerWithMemoryTransport();
    const err = new Error("redis unreachable");

    testLogger.error("seqAllocator.next failed", { docId: "doc-1", replicaId: "bob", error: errorMeta(err) });

    const entry = logs[0]!;
    expect(entry.docId).toBe("doc-1");
    expect(entry.replicaId).toBe("bob");
    expect((entry.error as { message: string }).message).toBe("redis unreachable");
    expect((entry.error as { stack: string }).stack).toContain("redis unreachable");
  });
});
