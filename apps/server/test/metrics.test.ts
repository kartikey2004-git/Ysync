import { afterEach, beforeEach, describe, expect, test } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createServer, type YSyncServer } from "../src/server.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import { register } from "../src/metrics.js";

let server: YSyncServer | undefined;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  register.resetMetrics();
});

afterEach(async () => {
  if (!server) return;
  await server.roomManager.close();
  await new Promise<void>((resolve) => server?.wss.close(() => resolve()));
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  server = undefined;
}, 15_000);

function startServer(): Promise<string> {
  server = createServer({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(),
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  return new Promise<string>((resolve) => {
    server?.httpServer.listen(0, () => {
      const address = server?.httpServer.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function get(url: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({
        status: res.statusCode!,
        body: data,
        contentType: res.headers["content-type"] ?? "",
      }));
    }).on("error", reject);
  });
}

describe("/metrics endpoint", () => {
  test("returns prometheus text format with correct content type", async () => {
    const base = await startServer();
    const { status, body, contentType } = await get(`${base}/metrics`);
    expect(status).toBe(200);
    expect(contentType).toContain("text/plain");
    expect(body).toContain("ysync_active_ws_connections");
    expect(body).toContain("ysync_active_rooms");
    expect(body).toContain("ysync_ops_received_total");
    expect(body).toContain("ysync_ops_persisted_total");
    expect(body).toContain("ysync_ops_broadcast_total");
    expect(body).toContain("ysync_errors_total");
    expect(body).toContain("ysync_op_persist_duration_seconds");
    expect(body).toContain("ysync_op_broadcast_duration_seconds");
    expect(body).toContain("ysync_redis_operation_duration_seconds");
  });

  test("active_ws_connections gauge increments on WS connect and decrements on close", async () => {
    const base = await startServer();
    const wsUrl = base.replace("http://", "ws://");
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const after = await register.getSingleMetricAsString("ysync_active_ws_connections");
    expect(after).toContain('ysync_active_ws_connections{app="ysync"} 1');

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
    // allow server-side close handler to fire
    await wait(50);

    const afterClose = await register.getSingleMetricAsString("ysync_active_ws_connections");
    expect(afterClose).toContain('ysync_active_ws_connections{app="ysync"} 0');
  });

  test("ops_received counter increments after an op is applied", async () => {
    const base = await startServer();
    const wsUrl = base.replace("http://", "ws://");

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const joinReply = new Promise<void>((resolve) => ws.once("message", () => resolve()));
    ws.send(JSON.stringify({ type: "join", docId: "doc-1", replicaId: "alice", sinceSeq: 0 }));
    await joinReply;

    const ackPromise = new Promise<void>((resolve) => ws.once("message", () => resolve()));
    ws.send(JSON.stringify({
      type: "op",
      docId: "doc-1",
      ops: [{ type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" }],
    }));
    await ackPromise;

    const after = await register.getSingleMetricAsString("ysync_ops_received_total");
    expect(after).toContain('ysync_ops_received_total{app="ysync"} 1');

    ws.close();
    await new Promise<void>((resolve) => ws.once("close", resolve));
  });
});
