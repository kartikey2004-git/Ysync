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

async function startServer(): Promise<{ url: string }> {
  server = createServer({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(),
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  await new Promise<void>((resolve) => server?.httpServer.listen(0, resolve));
  const address = server.httpServer.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${address.port}` };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
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

// Real server ko real WebSocket (loopback, ephemeral port) pe chalate hain,
// stores in-memory wale laga ke — poora wire protocol end-to-end test hota hai,
// bina Redis ya Postgres ke.
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
});
