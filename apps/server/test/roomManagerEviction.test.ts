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

// Throws on the first `failCount` unsubscribe calls, then delegates everything to a
// plain InMemoryPubSubBus — simulates one transient Redis unsubscribe failure.
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

describe("RoomManager idle-eviction retries after a failed unsubscribe", () => {
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

    // only the first unsubscribe call (the eviction's first attempt) will fail
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
    expect(loadCalls).toBe(1); // the first (and so far only) load, to create the room
    await manager.leave("doc-1", "alice"); // room is now empty, idle clock starts

    // the first eviction attempt (~15ms later) will fail (unsubscribe throws) — before
    // the fix this left the room permanently stale (sweepTimer already dead)
    await wait(30);
    // if the room is still registered (not evicted), rejoining shouldn't trigger a new
    // load — it should be reused, not recreated
    await manager.join("doc-1", "bob", fakeSocket());
    expect(loadCalls).toBe(1); // room reused, no reload from Postgres
    await manager.leave("doc-1", "bob"); // empty again, idle clock restarts

    // unsubscribe now succeeds every time — give eviction a chance to retry
    await wait(60);

    // the room should be evicted by now — a new join will reload it from persistence
    await manager.join("doc-1", "carol", fakeSocket());
    expect(loadCalls).toBe(2); // it had been evicted, so it reloaded
    await manager.leave("doc-1", "carol");
  });
});
