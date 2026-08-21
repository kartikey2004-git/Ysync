import { describe, expect, test } from "vitest";
import { Rga, type Op } from "@ysync/crdt";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

const ALPHABET = "abcdefghij";
const REPLICA_IDS = ["alice", "bob", "carol", "dave"];
// 4 clients x >=65 edits guarantees >= 260 total, comfortably above the 250 floor
// checked below even in the worst case (4 * 65 = 260)
const MIN_EDITS_PER_CLIENT = 65;
const MAX_EDITS_PER_CLIENT = 75;
const DELETE_PROBABILITY = 0.15;

interface SimulatedClient {
  replicaId: string;
  rga: Rga;
  outbox: Op[];
}

// Runs editCount local edits on a client's own Rga, all conflicting at index 0 — the
// most conflicting case possible: every client's edit is concurrent with everyone
// else's at the exact same anchor. This is the offline phase, RoomManager is never touched here.
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

// Simulates several clients editing the same document concurrently while offline,
// then reconnecting. Drives RoomManager directly (no WS/browser) — apps/web's
// DocumentClient isn't reused here since it needs a real WebSocket + IndexedDB; what's
// being verified is that the server integration (seq assignment, persistence,
// batching) doesn't break the same CRDT convergence guarantee that packages/crdt's
// property test already proves separately for the algorithm.
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

    // "reconnect": flush each client's offline outbox to the server, one at a time
    for (const client of clients) {
      await roomManager.applyClientOp(docId, client.replicaId, client.outbox);
    }

    const room = await roomManager.getOrCreateRoom(docId);
    const serverSnapshot = room.snapshot();

    // Zero data loss: every insert that ever happened is accounted for as a node
    // (visible or tombstoned) — delete only tombstones, it never removes a node.
    expect(serverSnapshot).toHaveLength(insertCount);

    // Convergence: an independent observer applying the same ops through plain
    // Rga.apply (never touching RoomManager) should build the exact same document the server did.
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
