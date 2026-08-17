import { describe, expect, test } from "vitest";
import { Rga, type Op } from "@ysync/crdt";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

const ALPHABET = "abcdefghij";
const REPLICA_IDS = ["alice", "bob", "carol", "dave"];
// 4 clients x >=65 edits se >= 260 total guarantee ho jata hai, worst case
// (4 * 65 = 260) mein bhi neeche wale 250 floor se aaraam se upar rahega
const MIN_EDITS_PER_CLIENT = 65;
const MAX_EDITS_PER_CLIENT = 75;
const DELETE_PROBABILITY = 0.15;

interface SimulatedClient {
  replicaId: string;
  rga: Rga;
  outbox: Op[];
}

// client ke apne Rga pe editCount local edits chalata hai, sab index 0 pe hi
// conflict kar rahe hain — yeh sabse zyada conflicting case hai: har client
// ka edit doosre sabke edit se exact same anchor pe concurrent hai. Yeh
// offline phase hai, yahan RoomManager ko koi touch nahi karta.
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

// Kai clients offline rehte hue same document concurrently edit karte hain,
// phir reconnect hote hain — yeh test simulate karta hai. RoomManager ko
// directly drive karta hai (WS/browser nahi), apps/web ka DocumentClient
// reuse nahi kiya kyunki usko real WebSocket + IndexedDB chahiye; yahan
// verify yeh ho raha hai ki server integration (seq assignment, persistence,
// batching) wahi CRDT convergence guarantee todhta nahi jo packages/crdt
// ka property test algorithm ke liye alag se prove kar chuka hai.
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

    // "reconnect": har client ka offline outbox ek-ek karke server pe flush karo
    for (const client of clients) {
      await roomManager.applyClientOp(docId, client.replicaId, client.outbox);
    }

    const room = await roomManager.getOrCreateRoom(docId);
    const serverSnapshot = room.snapshot();

    // Zero data loss: jitne bhi insert kabhi hue, sab node ke roop mein hisab
    // mein hain (visible ya tombstoned) — delete sirf tombstone karta hai, node hatata nahi.
    expect(serverSnapshot).toHaveLength(insertCount);

    // Convergence: ek independent observer wahi ops pure Rga.apply se laga ke
    // (RoomManager ko chhue bina) bilkul wahi document banana chahiye jo server ne banaya.
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
