import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { Op } from "@ysync/crdt";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import type { PersistenceStore } from "../src/persistence/PersistenceStore.js";
import type { RgaSnapshotNode } from "@ysync/crdt";

function fakeSocket() {
  const sent: string[] = [];
  const fake = { readyState: 1, OPEN: 1, send: (data: string) => sent.push(data) };
  return { socket: fake as unknown as WebSocket, sent };
}

function insertOp(counter: number, replicaId: string, value: string, originId: { counter: number; replicaId: string } | null = null): Op {
  return { type: "insert", id: { counter, replicaId }, originId, value };
}

describe("Persistence/ACK ordering", () => {
  let manager: RoomManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });

  test("ACK is sent only after successful persistence", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const events: string[] = [];

    const origAppend = persistenceStore.appendOps.bind(persistenceStore);
    persistenceStore.appendOps = async (docId: string, seq: number, ops: Op[]) => {
      events.push("persist");
      return origAppend(docId, seq, ops);
    };

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);

    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);

    events.push("check-ack");
    const ack = alice.sent.find((m) => JSON.parse(m).type === "ack");
    expect(ack).toBeDefined();
    expect(events.indexOf("persist")).toBeLessThan(events.indexOf("check-ack"));
  });

  test("persistence failure sends error instead of ACK", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    persistenceStore.appendOps = async () => {
      throw new Error("DB unavailable");
    };

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);

    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);

    const messages = alice.sent.map((m) => JSON.parse(m));
    const ack = messages.find((m: { type: string }) => m.type === "ack");
    const err = messages.find((m: { type: string }) => m.type === "error");

    expect(ack).toBeUndefined();
    expect(err).toBeDefined();
    expect(err.code).toBe("PERSIST_FAILED");
  });

  test("broadcast happens before persistence (optimistic)", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const events: string[] = [];
    const origAppend = persistenceStore.appendOps.bind(persistenceStore);
    persistenceStore.appendOps = async (docId: string, seq: number, ops: Op[]) => {
      events.push("persist");
      return origAppend(docId, seq, ops);
    };

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    const bob = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);
    await manager.join("doc-1", "bob", bob.socket);

    const origSend = bob.socket.send;
    (bob.socket as any).send = (data: string) => {
      const msg = JSON.parse(data);
      if (msg.type === "broadcast-op") events.push("broadcast");
      return origSend.call(bob.socket, data);
    };

    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);

    expect(events.indexOf("broadcast")).toBeLessThan(events.indexOf("persist"));
  });

  test("duplicate operation does not produce duplicate ACK", async () => {
    const persistenceStore = new InMemoryPersistenceStore();

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);

    const op = insertOp(1, "alice", "a");
    await manager.applyClientOp("doc-1", "alice", [op]);
    await manager.applyClientOp("doc-1", "alice", [op]);

    const loaded = await persistenceStore.load("doc-1");
    const allOps = loaded.ops.flatMap((b) => b.ops);
    const opIds = allOps.map((o) => `${o.type === "insert" ? o.id.counter : (o as any).targetId.counter}`);
    expect(new Set(opIds).size).toBe(allOps.length);
  });

  test("seq allocation failure sends error and does not apply op", async () => {
    const seqAlloc = new InMemorySeqAllocator();
    seqAlloc.next = async () => {
      throw new Error("Redis down");
    };

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: seqAlloc,
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);
    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);

    const messages = alice.sent.map((m) => JSON.parse(m));
    const err = messages.find((m: { type: string }) => m.type === "error");
    expect(err).toBeDefined();
    expect(err.code).toBe("SEQ_ALLOC_FAILED");
  });
});
