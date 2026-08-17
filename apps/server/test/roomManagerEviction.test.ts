import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import type { PubSubBus } from "../src/pubsub/PubSubBus.js";

function fakeSocket(): WebSocket {
  return { readyState: 1, OPEN: 1, send: () => {} } as unknown as WebSocket;
}

// pehle `failCount` unsubscribe calls throw karta hai, uske baad sab InMemoryPubSubBus
// ko delegate ho jaata hai — Redis ke ek transient unsubscribe failure ko simulate karta hai
class FlakyUnsubscribePubSubBus implements PubSubBus {
  private readonly inner = new InMemoryPubSubBus();
  private unsubscribeCalls = 0;

  constructor(private readonly failCount: number) {}

  publish(channel: string, message: string): Promise<void> {
    return this.inner.publish(channel, message);
  }
  subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    return this.inner.subscribe(channel, handler);
  }
  async unsubscribe(channel: string): Promise<void> {
    this.unsubscribeCalls += 1;
    if (this.unsubscribeCalls <= this.failCount) {
      throw new Error("simulated transient Redis unsubscribe failure");
    }
    return this.inner.unsubscribe(channel);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RoomManager idle-eviction retries after a failed unsubscribe (BUG-012)", () => {
  let manager: RoomManager | undefined;

  afterEach(async () => {
    await manager?.close();
    manager = undefined;
  });

  test("a room is not permanently stuck after one failed eviction attempt", async () => {
    const persistenceStore = new InMemoryPersistenceStore();
    let loadCalls = 0;
    const originalLoad = persistenceStore.load.bind(persistenceStore);
    persistenceStore.load = async (docId: string) => {
      loadCalls += 1;
      return originalLoad(docId);
    };

    // sirf pehla unsubscribe call (eviction ke pehle attempt ka) fail hoga
    const pubSubBus = new FlakyUnsubscribePubSubBus(1);

    manager = new RoomManager({
      pubSubBus,
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(),
      persistenceStore,
      sweepIntervalMs: 15,
      idleTimeoutMs: 15,
    });

    await manager.join("doc-1", "alice", fakeSocket());
    expect(loadCalls).toBe(1); // room create karne ke liye pehla (aur abhi tak sirf ek hi) load
    await manager.leave("doc-1", "alice"); // room khali ho gaya, idle clock shuru

    // pehla eviction attempt (~15ms baad) fail hoga (unsubscribe throw karega) —
    // fix se pehle yeh room ko hamesha ke liye stale chhod deta (sweepTimer already dead)
    await wait(30);
    // Agar room abhi bhi registered hai (evict nahi hua), rejoin karne se koi naya
    // load nahi hoga — reused hoga, recreate nahi
    await manager.join("doc-1", "bob", fakeSocket());
    expect(loadCalls).toBe(1); // room reused, dobara Postgres se load nahi hua
    await manager.leave("doc-1", "bob"); // phir se khali, idle clock restart

    // ab unsubscribe har baar succeed karega — eviction ko retry ka mauka do
    await wait(60);

    // room ab evict ho chuka hona chahiye — naya join isse dobara persistence se load karega
    await manager.join("doc-1", "carol", fakeSocket());
    expect(loadCalls).toBe(2); // evict ho chuka tha, isliye dobara load hua
    await manager.leave("doc-1", "carol");
  });
});
