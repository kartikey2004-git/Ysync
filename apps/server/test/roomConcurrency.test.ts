import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

function fakeSocket() {
  const sent: string[] = [];
  const fake = { readyState: 1, OPEN: 1, send: (data: string) => sent.push(data) };
  return { socket: fake as unknown as WebSocket, sent };
}

function makeManager(opts?: { persistenceStore?: InMemoryPersistenceStore }) {
  return new RoomManager({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
    persistenceStore: opts?.persistenceStore ?? new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
  });
}

describe("getOrCreateRoom concurrency", () => {
  test("two concurrent calls for the same doc return the same room", async () => {
    const mgr = makeManager();
    const [room1, room2] = await Promise.all([
      mgr.getOrCreateRoom("doc-1"),
      mgr.getOrCreateRoom("doc-1"),
    ]);
    expect(room1).toBe(room2);
    await mgr.close();
  });

  test("many concurrent calls for the same doc all get the same room", async () => {
    const mgr = makeManager();
    const rooms = await Promise.all(
      Array.from({ length: 20 }, () => mgr.getOrCreateRoom("doc-1")),
    );
    const unique = new Set(rooms);
    expect(unique.size).toBe(1);
    await mgr.close();
  });

  test("concurrent calls for different docs create separate rooms", async () => {
    const mgr = makeManager();
    const [r1, r2, r3] = await Promise.all([
      mgr.getOrCreateRoom("doc-A"),
      mgr.getOrCreateRoom("doc-B"),
      mgr.getOrCreateRoom("doc-C"),
    ]);
    expect(r1).not.toBe(r2);
    expect(r2).not.toBe(r3);
    await mgr.close();
  });

  test("failed room load does not poison the cache", async () => {
    const store = new InMemoryPersistenceStore();
    let callCount = 0;
    const originalLoad = store.load.bind(store);
    store.load = async (docId: string) => {
      callCount++;
      if (callCount === 1) throw new Error("simulated DB failure");
      return originalLoad(docId);
    };

    const mgr = makeManager({ persistenceStore: store });

    await expect(mgr.getOrCreateRoom("doc-1")).rejects.toThrow("failed to load");

    const room = await mgr.getOrCreateRoom("doc-1");
    expect(room).toBeDefined();
    expect(room.currentSeq()).toBe(0);
    await mgr.close();
  });

  test("retry after failure works — in-flight promise cleaned up", async () => {
    const store = new InMemoryPersistenceStore();
    let shouldFail = true;
    const originalLoad = store.load.bind(store);
    store.load = async (docId: string) => {
      if (shouldFail) throw new Error("simulated failure");
      return originalLoad(docId);
    };

    const mgr = makeManager({ persistenceStore: store });

    await expect(mgr.getOrCreateRoom("doc-1")).rejects.toThrow();

    shouldFail = false;
    const room = await mgr.getOrCreateRoom("doc-1");
    expect(room).toBeDefined();
    await mgr.close();
  });

  test("concurrent joins produce only one room with one timer set", async () => {
    const mgr = makeManager();
    const s1 = fakeSocket();
    const s2 = fakeSocket();
    const s3 = fakeSocket();

    const [j1, j2, j3] = await Promise.all([
      mgr.join("doc-1", "alice", s1.socket),
      mgr.join("doc-1", "bob", s2.socket),
      mgr.join("doc-1", "carol", s3.socket),
    ]);

    expect(j1.seq).toBe(j2.seq);
    expect(j2.seq).toBe(j3.seq);

    const room = await mgr.getOrCreateRoom("doc-1");
    expect(room.replicaIds()).toHaveLength(3);
    await mgr.close();
  });

  test("room eviction then reload creates a fresh room", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore,
      sweepIntervalMs: 10,
      idleTimeoutMs: 0,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);
    const room1 = await mgr.getOrCreateRoom("doc-1");

    await mgr.leave("doc-1", "alice");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const s2 = fakeSocket();
    await mgr.join("doc-1", "bob", s2.socket);
    const room2 = await mgr.getOrCreateRoom("doc-1");

    expect(room2).not.toBe(room1);
    await mgr.close();
  });
});
