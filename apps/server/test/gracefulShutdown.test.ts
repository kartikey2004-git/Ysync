import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

function fakeSocket() {
  const sent: string[] = [];
  let closed = false;
  const fake = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: () => {
      closed = true;
    },
    get isClosed() {
      return closed;
    },
  };
  return { socket: fake as unknown as WebSocket, sent, get isClosed() { return closed; } };
}

describe("Graceful shutdown", () => {
  test("roomManager.close() clears all sweep timers", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 10,
      idleTimeoutMs: 60_000,
    });

    const s1 = fakeSocket();
    const s2 = fakeSocket();
    await mgr.join("doc-1", "alice", s1.socket);
    await mgr.join("doc-2", "bob", s2.socket);

    await mgr.close();

    const room1 = await mgr.getOrCreateRoom("doc-1");
    expect(room1).toBeDefined();
    await mgr.close();
  });

  test("double close is safe", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);
    await mgr.close();
    await mgr.close();
  });

  test("rooms map is empty after close", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s1 = fakeSocket();
    const s2 = fakeSocket();
    await mgr.join("doc-1", "alice", s1.socket);
    await mgr.join("doc-2", "bob", s2.socket);

    await mgr.close();

    const freshRoom = await mgr.getOrCreateRoom("doc-1");
    expect(freshRoom.currentSeq()).toBe(0);
    await mgr.close();
  });
});

describe("Room lifecycle safety", () => {
  test("join → leave → evict does not leak timers", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 10,
      idleTimeoutMs: 0,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);
    await mgr.leave("doc-1", "alice");

    await new Promise((resolve) => setTimeout(resolve, 50));

    const room = await mgr.getOrCreateRoom("doc-1");
    expect(room).toBeDefined();
    expect(room.currentSeq()).toBe(0);
    await mgr.close();
  });

  test("join → leave → rejoin reloads state", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const seqCounter = new InMemorySeqCounter();
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 10,
      idleTimeoutMs: 0,
    });

    const s1 = fakeSocket();
    await mgr.join("doc-1", "alice", s1.socket);
    await mgr.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "x" },
    ]);
    await mgr.leave("doc-1", "alice");

    await new Promise((resolve) => setTimeout(resolve, 50));

    const s2 = fakeSocket();
    const result = await mgr.join("doc-1", "alice", s2.socket);
    expect(result.seq).toBe(1);
    await mgr.close();
  });

  test("concurrent join and leave do not corrupt room state", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s1 = fakeSocket();
    const s2 = fakeSocket();
    const s3 = fakeSocket();

    await mgr.join("doc-1", "alice", s1.socket);
    await Promise.all([
      mgr.join("doc-1", "bob", s2.socket),
      mgr.leave("doc-1", "alice"),
      mgr.join("doc-1", "carol", s3.socket),
    ]);

    const room = await mgr.getOrCreateRoom("doc-1");
    const ids = room.replicaIds();
    expect(ids).toContain("bob");
    expect(ids).toContain("carol");
    expect(ids).not.toContain("alice");
    await mgr.close();
  });
});
