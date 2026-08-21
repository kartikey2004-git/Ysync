import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryBroker, InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

function fakeSocket() {
  const sent: string[] = [];
  const fake = { readyState: 1, OPEN: 1, send: (data: string) => sent.push(data) };
  return { socket: fake as unknown as WebSocket, sent };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Simulates a "kill the server and restart it" scenario in-process: everything
// RoomManager had (Rooms, sweep timers) is discarded, but the persistence/seq/presence
// stores — the stand-ins for Postgres/Redis — survive, exactly like an external
// database survives a real process restart.
describe("RoomManager survives a restart", () => {
  test("state recovers from raw ops when no snapshot was ever taken", async () => {
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
    const alice = fakeSocket();
    await before.join("doc-1", "alice", alice.socket);
    await before.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" },
    ]);
    await before.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 2, replicaId: "alice" }, originId: { counter: 1, replicaId: "alice" }, value: "i" },
    ]);
    await before.close(); // simulating a "crash" — no clean shutdown snapshot, it just disappears

    const after = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore, // the same durable store the old process wrote to
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    const room = await after.getOrCreateRoom("doc-1");

    expect(room.snapshot().map((n) => n.value)).toEqual(["h", "i"]);
    expect(room.currentSeq()).toBe(2);

    await after.close();
  });

  test("state recovers from a snapshot plus trailing ops", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const seqCounter = new InMemorySeqCounter();

    const before = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 20,
      idleTimeoutMs: 60_000,
      snapshotOpThreshold: 1, // snapshot immediately after even a single op
    });
    const alice = fakeSocket();
    await before.join("doc-1", "alice", alice.socket);
    await before.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" },
    ]);
    await wait(60); // give the sweep tick time to take a snapshot
    // this op is applied *after* the snapshot, so it isn't compacted yet
    await before.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 2, replicaId: "alice" }, originId: { counter: 1, replicaId: "alice" }, value: "i" },
    ]);
    await before.close();

    const loaded = await persistenceStore.load("doc-1");
    expect(loaded.snapshotSeq).toBe(1); // confirms a snapshot was actually taken before the restart
    expect(loaded.ops).toHaveLength(1); // only the trailing batch (1 op) is left in the log

    const after = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    const room = await after.getOrCreateRoom("doc-1");

    expect(room.snapshot().map((n) => n.value)).toEqual(["h", "i"]);
    expect(room.currentSeq()).toBe(2);

    await after.close();
  });
});
