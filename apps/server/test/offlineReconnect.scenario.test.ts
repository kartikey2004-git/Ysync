import { describe, expect, test } from "vitest";
import { Rga, type Op } from "@ysync/crdt";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

const ALPHABET = "abcdefghij";
const REPLICA_IDS = ["alice", "bob", "carol", "dave"];
// 4 clients x >=65 edits guarantees >= 260 total, comfortably clearing the
// 250 floor asserted below even in the worst case (4 * 65 = 260).
const MIN_EDITS_PER_CLIENT = 65;
const MAX_EDITS_PER_CLIENT = 75;
const DELETE_PROBABILITY = 0.15;

interface SimulatedClient {
  replicaId: string;
  rga: Rga;
  outbox: Op[];
}

/**
 * Drives `editCount` local edits against `client`'s own Rga, all
 * contending for index 0 — the maximally-conflicting case: every client's
 * edits are concurrent with every other client's at the exact same
 * anchor. This is the offline phase: nothing here touches RoomManager.
 */
function editOffline(client: SimulatedClient, editCount: number): void {
  for (let i = 0; i < editCount; i++) {
    const currentLength = client.rga.read().length;
    const shouldDelete = currentLength > 0 && Math.random() < DELETE_PROBABILITY;
    const op = shouldDelete
      ? client.rga.localDelete(0)
      : client.rga.localInsert(0, ALPHABET[Math.floor(Math.random() * ALPHABET.length)] as string);
    client.outbox.push(op);
  }
}

/**
 * Simulates several clients editing the same document concurrently while
 * offline, then reconnecting — the scenario system-design.md §9.2 and
 * plan.md's Phase 6 call for. This drives RoomManager directly (no
 * WS/browser) rather than reusing apps/web's DocumentClient, which needs a
 * real WebSocket + IndexedDB; what's being verified here is that the
 * server integration (seq assignment, persistence, batching) preserves
 * the CRDT convergence guarantee packages/crdt's property test already
 * proves for the algorithm in isolation.
 */
describe("offline concurrent edits reconcile with zero data loss on reconnect", () => {
  test("N clients editing offline concurrently converge and lose nothing", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    const roomManager = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });
    const docId = "offline-scenario-doc";

    const clients: SimulatedClient[] = REPLICA_IDS.map((replicaId) => ({
      replicaId,
      rga: new Rga(replicaId),
      outbox: [],
    }));

    for (const client of clients) {
      const editCount = MIN_EDITS_PER_CLIENT + Math.floor(Math.random() * (MAX_EDITS_PER_CLIENT - MIN_EDITS_PER_CLIENT));
      editOffline(client, editCount);
    }

    const totalEdits = clients.reduce((sum, c) => sum + c.outbox.length, 0);
    const insertCount = clients.reduce((sum, c) => sum + c.outbox.filter((op) => op.type === "insert").length, 0);
    expect(totalEdits).toBeGreaterThanOrEqual(250);

    // "reconnect": flush every client's offline outbox to the server, one client at a time
    for (const client of clients) {
      await roomManager.applyClientOp(docId, client.replicaId, client.outbox);
    }

    const room = await roomManager.getOrCreateRoom(docId);
    const serverSnapshot = room.snapshot();

    // Zero data loss: every insert ever made is still accounted for as a
    // node (visible or tombstoned) — deletes tombstone, they never remove.
    expect(serverSnapshot).toHaveLength(insertCount);

    // Convergence: an independent observer applying the exact same ops
    // through pure Rga.apply (never touching RoomManager) must land on
    // the identical document as what the server produced.
    const observer = new Rga("observer");
    for (const client of clients) {
      observer.applyAll(client.outbox);
    }
    const observerText = observer.read();
    const serverText = Rga.fromSnapshot(serverSnapshot, "check").read();
    expect(serverText).toEqual(observerText);

    await roomManager.close();
  });
});
