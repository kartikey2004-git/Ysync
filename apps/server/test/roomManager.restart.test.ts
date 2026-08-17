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

// "Server kill karke restart karo" wala scenario, in-process simulate kiya hai:
// RoomManager ke paas jo bhi tha (Rooms, sweep timers) sab discard ho jata hai,
// lekin persistence/seq/presence stores — jo Postgres/Redis ke stand-in hain —
// bache rehte hain, bilkul waise jaise real process restart mein external
// database bacha rehta hai.
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
    await before.close(); // "crash" simulate kar rahe hain — koi clean shutdown snapshot nahi, bas gayab

    const after = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(seqCounter),
      persistenceStore, // wahi durable store jispe purane process ne likha tha
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
      snapshotOpThreshold: 1, // ek bhi op ho, snapshot le lo turant
    });
    const alice = fakeSocket();
    await before.join("doc-1", "alice", alice.socket);
    await before.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" },
    ]);
    await wait(60); // sweep tick ko time do snapshot lene ke liye
    // yeh op snapshot ke *baad* apply hua hai, abhi compact nahi hua
    await before.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 2, replicaId: "alice" }, originId: { counter: 1, replicaId: "alice" }, value: "i" },
    ]);
    await before.close();

    const loaded = await persistenceStore.load("doc-1");
    expect(loaded.snapshotSeq).toBe(1); // confirm karta hai ki restart se pehle snapshot waqai liya gaya tha
    expect(loaded.ops).toHaveLength(1); // sirf trailing batch (1 op) bacha hai log mein

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
