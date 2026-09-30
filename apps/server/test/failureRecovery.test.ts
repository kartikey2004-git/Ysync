import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { Op } from "@ysync/crdt";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryBroker, InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

function fakeSocket() {
  const sent: string[] = [];
  const fake = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: () => { (fake as any).readyState = 3; },
  };
  return { socket: fake as unknown as WebSocket, sent };
}

function insertOp(counter: number, replicaId: string, value: string, originId: { counter: number; replicaId: string } | null = null): Op {
  return { type: "insert", id: { counter, replicaId }, originId, value };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Failure recovery scenarios", () => {
  let manager: RoomManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });

  test("server restart: state recovers from persistence", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const seqCounter = new InMemorySeqCounter();

    const m1 = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await m1.join("doc-1", "alice", alice.socket);
    await m1.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);
    await m1.applyClientOp("doc-1", "alice", [
      insertOp(2, "alice", "b", { counter: 1, replicaId: "alice" }),
    ]);
    await m1.close();

    const m2 = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    manager = m2;

    const bob = fakeSocket();
    const result = await m2.join("doc-1", "bob", bob.socket);
    const room = await m2.getOrCreateRoom("doc-1");
    expect(room.snapshot().map((n) => n.value)).toEqual(["a", "b"]);
  });

  test("Redis restart: seeding ensures sequence continuity", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const seqCounter = new InMemorySeqCounter();

    const m1 = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter, {
        getLatestSeq: async (docId) => {
          const loaded = await persistenceStore.load(docId);
          return loaded.latestSeq;
        },
      }),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await m1.join("doc-1", "alice", alice.socket);
    await m1.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);
    await m1.applyClientOp("doc-1", "alice", [
      insertOp(2, "alice", "b", { counter: 1, replicaId: "alice" }),
    ]);
    await m1.close();

    seqCounter.reset("doc-1");

    const m2 = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter, {
        getLatestSeq: async (docId) => {
          const loaded = await persistenceStore.load(docId);
          return loaded.latestSeq;
        },
      }),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    manager = m2;

    const bob = fakeSocket();
    await m2.join("doc-1", "bob", bob.socket);
    await m2.applyClientOp("doc-1", "bob", [
      insertOp(1, "bob", "c", { counter: 2, replicaId: "alice" }),
    ]);

    const room = await m2.getOrCreateRoom("doc-1");
    expect(room.currentSeq()).toBeGreaterThan(2);
  });

  test("persistence failure: op still applied to CRDT, error sent", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    let failNext = false;
    const origAppend = persistenceStore.appendOps.bind(persistenceStore);
    persistenceStore.appendOps = async (docId: string, seq: number, ops: Op[]) => {
      if (failNext) throw new Error("DB write failed");
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

    failNext = true;
    await manager.applyClientOp("doc-1", "alice", [
      insertOp(2, "alice", "b", { counter: 1, replicaId: "alice" }),
    ]);

    const messages = alice.sent.map((m) => JSON.parse(m));
    const errors = messages.filter((m: { type: string }) => m.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0].code).toBe("PERSIST_FAILED");

    const room = await manager.getOrCreateRoom("doc-1");
    const values = room.snapshot().map((n) => n.value);
    expect(values).toContain("a");
    expect(values).toContain("b");
  });

  test("reconnect after persistence failure: client can retry safely", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    let failCount = 0;
    const origAppend = persistenceStore.appendOps.bind(persistenceStore);
    persistenceStore.appendOps = async (docId: string, seq: number, ops: Op[]) => {
      failCount++;
      if (failCount === 2) throw new Error("transient DB failure");
      return origAppend(docId, seq, ops);
    };

    const seqCounter = new InMemorySeqCounter();

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);

    const op1 = insertOp(1, "alice", "a");
    const op2 = insertOp(2, "alice", "b", { counter: 1, replicaId: "alice" });

    await manager.applyClientOp("doc-1", "alice", [op1]);
    await manager.applyClientOp("doc-1", "alice", [op2]);

    await manager.applyClientOp("doc-1", "alice", [op2]);

    const loaded = await persistenceStore.load("doc-1");
    const allOps = loaded.ops.flatMap((b) => b.ops);
    const insertOps = allOps.filter((o) => o.type === "insert");
    const uniqueIds = new Set(insertOps.map((o) => `${o.id.counter}:${o.id.replicaId}`));
    expect(uniqueIds.size).toBe(insertOps.length);
  });

  test("pub/sub unavailable: op still applied and persisted locally", async () => {
    const pubSubBus = new InMemoryPubSubBus();
    const origPublish = pubSubBus.publish.bind(pubSubBus);
    let failPublish = false;
    pubSubBus.publish = async (channel: string, message: string) => {
      if (failPublish) throw new Error("Redis pub/sub down");
      return origPublish(channel, message);
    };

    const persistenceStore = new InMemoryPersistenceStore();

    manager = new RoomManager({
      pubSubBus,
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);

    failPublish = true;
    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);

    const acks = alice.sent.map((m) => JSON.parse(m)).filter((m: { type: string }) => m.type === "ack");
    expect(acks.length).toBe(1);

    const loaded = await persistenceStore.load("doc-1");
    expect(loaded.ops.flatMap((b) => b.ops)).toHaveLength(1);
  });
});
