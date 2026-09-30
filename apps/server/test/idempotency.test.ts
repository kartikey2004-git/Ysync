import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import type { Op } from "@ysync/crdt";

function fakeSocket() {
  const sent: string[] = [];
  const fake = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  };
  return { socket: fake as unknown as WebSocket, sent };
}

const insertOp = (counter: number, replicaId: string, originCounter: number | null = null): Op => ({
  type: "insert",
  id: { counter, replicaId },
  originId: originCounter !== null ? { counter: originCounter, replicaId } : null,
  value: String.fromCharCode(96 + counter),
});

describe("Operation idempotency", () => {
  test("same op submitted twice produces only one persisted record", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);

    const op = insertOp(1, "alice");
    await mgr.applyClientOp("doc-1", "alice", [op]);
    await mgr.applyClientOp("doc-1", "alice", [op]);

    const loaded = await persistenceStore.load("doc-1");
    const allOps = loaded.ops.flatMap((b) => b.ops);
    const opKeys = allOps.map((o) => `${o.id.replicaId}:${o.id.counter}`);
    expect(new Set(opKeys).size).toBe(opKeys.length);
    await mgr.close();
  });

  test("same op from two connections is handled idempotently", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const seqCounter = new InMemorySeqCounter();
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s1 = fakeSocket();
    const s2 = fakeSocket();
    await mgr.join("doc-1", "alice", s1.socket);
    await mgr.join("doc-1", "alice-reconnect", s2.socket);

    const op = insertOp(1, "alice");
    await Promise.all([
      mgr.applyClientOp("doc-1", "alice", [op]),
      mgr.applyClientOp("doc-1", "alice-reconnect", [op]),
    ]);

    const loaded = await persistenceStore.load("doc-1");
    const allOps = loaded.ops.flatMap((b) => b.ops);
    const opKeys = allOps.map((o) => `${o.id.replicaId}:${o.id.counter}`);
    expect(new Set(opKeys).size).toBe(opKeys.length);
    await mgr.close();
  });

  test("same op after server restart is handled idempotently", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const seqCounter = new InMemorySeqCounter();

    const before = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    const s1 = fakeSocket();
    await before.join("doc-1", "alice", s1.socket);

    const op = insertOp(1, "alice");
    await before.applyClientOp("doc-1", "alice", [op]);
    await before.close();

    const after = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    const s2 = fakeSocket();
    await after.join("doc-1", "alice", s2.socket);

    await after.applyClientOp("doc-1", "alice", [op]);

    const loaded = await persistenceStore.load("doc-1");
    const allOps = loaded.ops.flatMap((b) => b.ops);
    const opKeys = allOps.map((o) => `${o.id.replicaId}:${o.id.counter}`);
    expect(new Set(opKeys).size).toBe(opKeys.length);
    await after.close();
  });

  test("CRDT state converges after duplicate ops", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);

    const op1 = insertOp(1, "alice");
    const op2 = insertOp(2, "alice", 1);
    const op3 = insertOp(3, "alice", 2);

    await mgr.applyClientOp("doc-1", "alice", [op1]);
    await mgr.applyClientOp("doc-1", "alice", [op2]);
    await mgr.applyClientOp("doc-1", "alice", [op1]);
    await mgr.applyClientOp("doc-1", "alice", [op3]);
    await mgr.applyClientOp("doc-1", "alice", [op2]);

    const room = await mgr.getOrCreateRoom("doc-1");
    const values = room.snapshot().map((n) => n.value);
    expect(values).toEqual(["a", "b", "c"]);
    await mgr.close();
  });
});
