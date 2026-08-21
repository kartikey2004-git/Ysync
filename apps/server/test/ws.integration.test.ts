import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import type { ServerMessage } from "@ysync/protocol";
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

async function startServer(options?: { allowedOrigins?: string[] }): Promise<{ url: string }> {
  server = createServer({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(),
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
    allowedOrigins: options?.allowedOrigins,
  });
  await new Promise<void>((resolve) => server?.httpServer.listen(0, resolve));
  const address = server.httpServer.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${address.port}` };
}

function connect(url: string, wsOptions?: WebSocket.ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, wsOptions);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as ServerMessage));
  });
}

function send(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

async function joinAndAwaitCatchUp(socket: WebSocket, docId: string, replicaId: string): Promise<ServerMessage> {
  const snapshotPromise = nextMessage(socket);
  send(socket, { type: "join", docId, replicaId, sinceSeq: 0 });
  return snapshotPromise;
}

// Runs the real server over a real WebSocket (loopback, ephemeral port) with
// in-memory stores plugged in — this tests the whole wire protocol end-to-end without needing Redis or Postgres.
describe("WS integration (single instance, real sockets)", () => {
  test("join on a brand-new room returns an empty incremental sync (no history to fall back on)", async () => {
    const { url } = await startServer();
    const alice = await connect(url);

    const reply = await joinAndAwaitCatchUp(alice, "doc-1", "alice");

    expect(reply).toEqual({ type: "sync", docId: "doc-1", seq: 0, ops: [] });
    alice.close();
  });

  test("an op from one client acks the sender and broadcasts to another", async () => {
    const { url } = await startServer();
    const alice = await connect(url);
    const bob = await connect(url);

    await joinAndAwaitCatchUp(alice, "doc-1", "alice");
    await joinAndAwaitCatchUp(bob, "doc-1", "bob");

    const ackPromise = nextMessage(alice);
    const broadcastPromise = nextMessage(bob);
    send(alice, {
      type: "op",
      docId: "doc-1",
      ops: [{ type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" }],
    });

    const [ack, broadcast] = await Promise.all([ackPromise, broadcastPromise]);
    expect(ack).toMatchObject({ type: "ack", docId: "doc-1", seq: 1 });
    expect(broadcast).toMatchObject({ type: "broadcast-op", docId: "doc-1", seq: 1 });

    alice.close();
    bob.close();
  });

  test("presence updates and leave notify other clients in the room", async () => {
    const { url } = await startServer();
    const alice = await connect(url);
    const bob = await connect(url);

    await joinAndAwaitCatchUp(alice, "doc-1", "alice");
    await joinAndAwaitCatchUp(bob, "doc-1", "bob");

    const presenceUpdatePromise = nextMessage(bob);
    send(alice, { type: "presence", docId: "doc-1", cursor: 2, name: "Alice" });
    expect(await presenceUpdatePromise).toEqual({
      type: "presence-update",
      docId: "doc-1",
      replicaId: "alice",
      cursor: 2,
      name: "Alice",
    });

    const presenceLeavePromise = nextMessage(bob);
    send(alice, { type: "leave", docId: "doc-1" });
    expect(await presenceLeavePromise).toEqual({ type: "presence-leave", docId: "doc-1", replicaId: "alice" });

    alice.close();
    bob.close();
  });

  test("the first message on a connection must be join", async () => {
    const { url } = await startServer();
    const alice = await connect(url);

    const errorPromise = nextMessage(alice);
    send(alice, {
      type: "op",
      docId: "doc-1",
      ops: [{ type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" }],
    });
    const message = await errorPromise;

    expect(message.type).toBe("error");
    alice.close();
  });

  test("a second join with the same replicaId closes the old socket, and the new one stays registered", async () => {
    const { url } = await startServer();
    const first = await connect(url);
    await joinAndAwaitCatchUp(first, "doc-1", "alice");

    const firstClosePromise = new Promise<number>((resolve) => first.once("close", (code) => resolve(code)));
    const second = await connect(url);
    await joinAndAwaitCatchUp(second, "doc-1", "alice");

    // the first socket's own close event races here — this is exactly the race that
    // Room.leave's identity check (room.ts) guards against, so the new socket doesn't get evicted
    expect(await firstClosePromise).toBe(4000);

    const bob = await connect(url);
    await joinAndAwaitCatchUp(bob, "doc-1", "bob");

    const secondBroadcast = nextMessage(second);
    send(bob, {
      type: "op",
      docId: "doc-1",
      ops: [{ type: "insert", id: { counter: 1, replicaId: "bob" }, originId: null, value: "h" }],
    });
    await expect(secondBroadcast).resolves.toMatchObject({ type: "broadcast-op" });

    second.close();
    bob.close();
  });

  test("oversized payloads close the connection instead of being accepted", async () => {
    const { url } = await startServer();
    const alice = await connect(url);

    const closePromise = new Promise<number>((resolve) => alice.once("close", (code) => resolve(code)));
    // MAX_WS_PAYLOAD_BYTES (1 MiB) se kaafi upar
    alice.send(JSON.stringify({ type: "join", docId: "d".repeat(2_000_000), replicaId: "alice", sinceSeq: 0 }));

    expect(await closePromise).toBe(1009); // "Message Too Big"
  });

  test("a disallowed origin is rejected once allowedOrigins is configured", async () => {
    const { url } = await startServer({ allowedOrigins: ["https://allowed.example"] });
    await expect(connect(url, { origin: "https://evil.example" })).rejects.toThrow();
  });

  test("an allowed origin still connects once allowedOrigins is configured", async () => {
    const { url } = await startServer({ allowedOrigins: ["https://allowed.example"] });
    const alice = await connect(url, { origin: "https://allowed.example" });
    alice.close();
  });

  test("origin checking is disabled by default (no allowedOrigins configured)", async () => {
    const { url } = await startServer();
    const alice = await connect(url, { origin: "https://anything.example" });
    alice.close();
  });
});
