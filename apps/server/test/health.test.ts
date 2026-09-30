import { afterEach, describe, expect, test } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, type YSyncServer } from "../src/server.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

let server: YSyncServer | undefined;

afterEach(async () => {
  if (!server) return;
  await server.roomManager.close();
  await new Promise<void>((resolve) => server?.wss.close(() => resolve()));
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  server = undefined;
});

function startServer(healthCheck?: () => Promise<{ postgres: boolean; redis: boolean }>): Promise<string> {
  server = createServer({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(),
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
    healthCheck,
  });
  return new Promise<string>((resolve) => {
    server?.httpServer.listen(0, () => {
      const address = server?.httpServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    }).on("error", reject);
  });
}

describe("/health endpoint", () => {
  test("returns 200 with status ok when no healthCheck is provided", async () => {
    const base = await startServer();
    const { status, body } = await get(`${base}/health`);
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  test("returns 200 when all checks pass", async () => {
    const base = await startServer(async () => ({ postgres: true, redis: true }));
    const { status, body } = await get(`${base}/health`);
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok", checks: { postgres: true, redis: true } });
  });

  test("returns 503 when postgres check fails", async () => {
    const base = await startServer(async () => ({ postgres: false, redis: true }));
    const { status, body } = await get(`${base}/health`);
    expect(status).toBe(503);
    expect(body).toEqual({ status: "error", checks: { postgres: false, redis: true } });
  });

  test("returns 503 when redis check fails", async () => {
    const base = await startServer(async () => ({ postgres: true, redis: false }));
    const { status, body } = await get(`${base}/health`);
    expect(status).toBe(503);
    expect(body).toEqual({ status: "error", checks: { postgres: true, redis: false } });
  });

  test("returns 503 when healthCheck throws", async () => {
    const base = await startServer(async () => { throw new Error("connection lost"); });
    const { status, body } = await get(`${base}/health`);
    expect(status).toBe(503);
    expect(body).toEqual({ status: "error", checks: { postgres: false, redis: false } });
  });
});
