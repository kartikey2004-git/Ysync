import { afterEach, describe, expect, test } from "vitest";
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
    close: () => { (fake as any).readyState = 3; },
  };
  return { socket: fake as unknown as WebSocket, sent };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function insertOp(counter: number, replicaId: string, value: string, originId: { counter: number; replicaId: string } | null = null): Op {
  return { type: "insert", id: { counter, replicaId }, originId, value };
}

describe("Room lifecycle — join/leave/evict/reload", () => {
  let manager: RoomManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });

  test("join → leave → evict → rejoin reloads from persistence", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    let loadCount = 0;
    const origLoad = persistenceStore.load.bind(persistenceStore);
    persistenceStore.load = async (docId: string) => {
      loadCount++;
      return origLoad(docId);
    };

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 20,
      idleTimeoutMs: 20,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);
    expect(loadCount).toBe(1);

    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "x")]);
    await manager.leave("doc-1", "alice");

    await wait(150);

    const bob = fakeSocket();
    const result = await manager.join("doc-1", "bob", bob.socket);
    expect(loadCount).toBe(2);

    const room = await manager.getOrCreateRoom("doc-1");
    expect(room.snapshot().map((n) => n.value)).toContain("x");
  });

  test("join → leave → rejoin (before eviction) reuses room", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    let loadCount = 0;
    const origLoad = persistenceStore.load.bind(persistenceStore);
    persistenceStore.load = async (docId: string) => {
      loadCount++;
      return origLoad(docId);
    };

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    await manager.join("doc-1", "alice", fakeSocket().socket);
    await manager.leave("doc-1", "alice");
    await manager.join("doc-1", "bob", fakeSocket().socket);

    expect(loadCount).toBe(1);
  });

  test("concurrent join does not create duplicate timers", async () => {
    const pubSubBus = new InMemoryPubSubBus();
    const subscribeCalls: string[] = [];
    const origSub = pubSubBus.subscribe.bind(pubSubBus);
    pubSubBus.subscribe = async (channel: string, handler: (message: string) => void) => {
      subscribeCalls.push(channel);
      return origSub(channel, handler);
    };

    const persistenceStore = new InMemoryPersistenceStore();
    const origLoad = persistenceStore.load.bind(persistenceStore);
    persistenceStore.load = async (docId: string) => {
      await wait(20);
      return origLoad(docId);
    };

    manager = new RoomManager({
      pubSubBus,
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    await Promise.all([
      manager.join("doc-1", "alice", fakeSocket().socket),
      manager.join("doc-1", "bob", fakeSocket().socket),
    ]);

    const docChannelSubs = subscribeCalls.filter((c) => c === "doc:doc-1");
    expect(docChannelSubs).toHaveLength(1);
  });

  test("snapshot during active room preserves state for recovery", async () => {
    const persistenceStore = new InMemoryPersistenceStore();

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 20,
      idleTimeoutMs: 60_000,
      snapshotOpThreshold: 1,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);
    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);

    await wait(60);

    await manager.applyClientOp("doc-1", "alice", [
      insertOp(2, "alice", "b", { counter: 1, replicaId: "alice" }),
    ]);

    const loaded = await persistenceStore.load("doc-1");
    expect(loaded.snapshotSeq).toBeGreaterThan(0);

    const room = await manager.getOrCreateRoom("doc-1");
    const values = room.snapshot().map((n) => n.value);
    expect(values).toContain("a");
    expect(values).toContain("b");
  });

  test("operation during eviction window completes safely", async () => {
    const persistenceStore = new InMemoryPersistenceStore();

    manager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 20,
      idleTimeoutMs: 20,
    });

    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket);
    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "x")]);
    await manager.leave("doc-1", "alice");

    await wait(10);

    const bob = fakeSocket();
    await manager.join("doc-1", "bob", bob.socket);
    await manager.applyClientOp("doc-1", "bob", [
      insertOp(1, "bob", "y", { counter: 1, replicaId: "alice" }),
    ]);

    const room = await manager.getOrCreateRoom("doc-1");
    const values = room.snapshot().map((n) => n.value);
    expect(values).toContain("x");
    expect(values).toContain("y");
  });
});

describe("Catch-up after eviction", () => {
  let manager: RoomManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });

  test("client joining with sinceSeq gets incremental or full snapshot", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
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
    await manager.applyClientOp("doc-1", "alice", [insertOp(1, "alice", "a")]);
    await manager.applyClientOp("doc-1", "alice", [
      insertOp(2, "alice", "b", { counter: 1, replicaId: "alice" }),
    ]);

    const bob = fakeSocket();
    const result = await manager.join("doc-1", "bob", bob.socket, 1);

    if (result.kind === "sync") {
      expect(result.ops.length).toBeGreaterThan(0);
    } else {
      expect(result.state.length).toBeGreaterThan(0);
    }
    expect(result.seq).toBe(2);
  });
});
