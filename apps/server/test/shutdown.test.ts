import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import type { PubSubBus } from "../src/pubsub/PubSubBus.js";

function fakeSocket() {
  const sent: string[] = [];
  const fake = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
    close: () => { (fake as any).readyState = 3; },
  };
  return { socket: fake as unknown as WebSocket, sent };
}

class TrackingPubSubBus implements PubSubBus {
  private readonly inner = new InMemoryPubSubBus();
  readonly subscribed = new Set<string>();
  readonly unsubscribed: string[] = [];

  async publish(channel: string, message: string): Promise<void> {
    return this.inner.publish(channel, message);
  }
  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.subscribed.add(channel);
    return this.inner.subscribe(channel, handler);
  }
  async unsubscribe(channel: string): Promise<void> {
    this.subscribed.delete(channel);
    this.unsubscribed.push(channel);
    return this.inner.unsubscribe(channel);
  }
  async close(): Promise<void> {
    return this.inner.close();
  }
}

describe("Graceful shutdown (RoomManager.close)", () => {
  test("close() clears all rooms and unsubscribes pub/sub", async () => {
    const pubSub = new TrackingPubSubBus();
    const mgr = new RoomManager({
      pubSubBus: pubSub,
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    await mgr.join("doc-A", "alice", fakeSocket().socket);
    await mgr.join("doc-B", "bob", fakeSocket().socket);

    expect(pubSub.subscribed.size).toBe(4);

    await mgr.close();

    expect(pubSub.unsubscribed).toContain("doc:doc-A");
    expect(pubSub.unsubscribed).toContain("presence:doc-A");
    expect(pubSub.unsubscribed).toContain("doc:doc-B");
    expect(pubSub.unsubscribed).toContain("presence:doc-B");
  });

  test("close() is idempotent — calling twice does not throw", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    await mgr.join("doc-1", "alice", fakeSocket().socket);
    await mgr.close();
    await mgr.close();
  });

  test("close() survives unsubscribe failures", async () => {
    const pubSub = new TrackingPubSubBus();
    const origUnsub = pubSub.unsubscribe.bind(pubSub);
    let calls = 0;
    pubSub.unsubscribe = async (channel: string) => {
      calls++;
      if (calls === 1) throw new Error("transient unsubscribe failure");
      return origUnsub(channel);
    };

    const mgr = new RoomManager({
      pubSubBus: pubSub,
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    await mgr.join("doc-1", "alice", fakeSocket().socket);
    await mgr.close();
  });

  test("no tick fires after close()", async () => {
    const store = new InMemoryPersistenceStore();
    let loadCalls = 0;
    const origLoad = store.load.bind(store);
    store.load = async (docId: string) => {
      loadCalls++;
      return origLoad(docId);
    };

    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 20,
      idleTimeoutMs: 20,
    });

    await mgr.join("doc-1", "alice", fakeSocket().socket);
    expect(loadCalls).toBe(1);
    await mgr.close();

    await new Promise((r) => setTimeout(r, 100));
    expect(loadCalls).toBe(1);
  });
});
