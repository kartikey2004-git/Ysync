import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
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
    send: (data: string) => {
      sent.push(data);
    },
  };
  return { socket: fake as unknown as WebSocket, sent };
}

function messageTypes(sent: string[]): string[] {
  return sent.map((raw) => (JSON.parse(raw) as { type: string }).type);
}

/**
 * Two independent RoomManagers sharing one in-memory "Redis" (broker,
 * presence store, seq counter) — simulating two server processes behind
 * the same real Redis, per system-design.md §6.2. See
 * docs/changes/phase-3-server-core.md for why this is a meaningful
 * substitute for a live Redis in the default test run.
 */
function createTestManagers() {
  const broker = new InMemoryBroker();
  const presenceStore = new InMemoryPresenceStore();
  const seqCounter = new InMemorySeqCounter();
  const persistenceStore = new InMemoryPersistenceStore();

  const managerA = new RoomManager({
    pubSubBus: new InMemoryPubSubBus(broker),
    presenceStore,
    seqAllocator: new InMemorySeqAllocator(seqCounter),
    persistenceStore,
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
  });
  const managerB = new RoomManager({
    pubSubBus: new InMemoryPubSubBus(broker),
    presenceStore,
    seqAllocator: new InMemorySeqAllocator(seqCounter),
    persistenceStore,
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
  });

  return { managerA, managerB };
}

const managersToClose: RoomManager[] = [];

afterEach(async () => {
  await Promise.all(managersToClose.splice(0).map((m) => m.close()));
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("RoomManager multi-instance fan-out", () => {
  test("an op applied on instance A is visible on instance B", async () => {
    const { managerA, managerB } = createTestManagers();
    managersToClose.push(managerA, managerB);
    const alice = fakeSocket();
    const bob = fakeSocket();

    await managerA.join("doc-1", "alice", alice.socket);
    await managerB.join("doc-1", "bob", bob.socket);

    await managerA.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" },
    ]);
    await settle();

    const roomA = await managerA.getOrCreateRoom("doc-1");
    const roomB = await managerB.getOrCreateRoom("doc-1");
    expect(roomA.snapshot()).toEqual(roomB.snapshot());
    expect(roomB.snapshot()[0]?.value).toBe("h");

    // alice (the sender) gets an ack, not a broadcast of her own op
    expect(messageTypes(alice.sent)).toContain("ack");
    expect(messageTypes(alice.sent)).not.toContain("broadcast-op");
    // bob, on the other instance, only ever sees it via fan-out
    expect(messageTypes(bob.sent)).toContain("broadcast-op");
  });

  test("concurrent ops from both instances converge to the same document", async () => {
    const { managerA, managerB } = createTestManagers();
    managersToClose.push(managerA, managerB);
    const alice = fakeSocket();
    const bob = fakeSocket();

    await managerA.join("doc-1", "alice", alice.socket);
    await managerB.join("doc-1", "bob", bob.socket);

    await managerA.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "a" },
    ]);
    await managerB.applyClientOp("doc-1", "bob", [
      { type: "insert", id: { counter: 1, replicaId: "bob" }, originId: null, value: "b" },
    ]);
    await settle();

    const roomA = await managerA.getOrCreateRoom("doc-1");
    const roomB = await managerB.getOrCreateRoom("doc-1");
    expect(roomA.snapshot()).toEqual(roomB.snapshot());
    expect(roomA.snapshot()).toHaveLength(2);
  });

  test("presence updates fan out across instances and expire via sweep", async () => {
    const { managerA, managerB } = createTestManagers();
    managersToClose.push(managerA, managerB);
    const alice = fakeSocket();
    const bob = fakeSocket();

    await managerA.join("doc-1", "alice", alice.socket);
    await managerB.join("doc-1", "bob", bob.socket);

    await managerA.updatePresence("doc-1", "alice", { cursor: 3, name: "Alice" });
    await settle();

    expect(messageTypes(bob.sent)).toContain("presence-update");
    expect(await managerB.listPresence("doc-1")).toEqual([
      { replicaId: "alice", cursor: 3, name: "Alice" },
    ]);

    await managerA.removePresence("doc-1", "alice");
    await settle();

    expect(messageTypes(bob.sent)).toContain("presence-leave");
    expect(await managerB.listPresence("doc-1")).toEqual([]);
  });
});
