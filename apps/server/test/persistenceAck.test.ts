import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import type { Op } from "@ysync/crdt";

function fakeSocket() {
  const sent: string[] = [];
  const fake = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => sent.push(data),
  };
  return { socket: fake as unknown as WebSocket, sent };
}

function parseSent(sent: string[]) {
  return sent.map((s) => JSON.parse(s));
}

const insertOp = (counter: number, replicaId: string): Op => ({
  type: "insert",
  id: { counter, replicaId },
  originId: null,
  value: String.fromCharCode(96 + counter),
});

describe("Persistence vs ACK semantics", () => {
  test("successful persist sends ACK to client", async () => {
    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);
    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const msgs = parseSent(s.sent);
    const ack = msgs.find((m: { type: string }) => m.type === "ack");
    expect(ack).toBeDefined();
    expect(ack.seq).toBe(1);
    await mgr.close();
  });

  test("persistence failure sends error instead of ACK", async () => {
    const store = new InMemoryPersistenceStore();
    const originalAppend = store.appendOps.bind(store);
    let shouldFail = false;
    store.appendOps = async (...args: Parameters<typeof originalAppend>) => {
      if (shouldFail) throw new Error("simulated DB failure");
      return originalAppend(...args);
    };

    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);

    shouldFail = true;
    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const msgs = parseSent(s.sent);
    const ack = msgs.find((m: { type: string }) => m.type === "ack");
    const err = msgs.find((m: { type: string }) => m.type === "error");
    expect(ack).toBeUndefined();
    expect(err).toBeDefined();
    expect(err.code).toBe("PERSIST_FAILED");
    await mgr.close();
  });

  test("broadcast is sent even when persistence fails", async () => {
    const store = new InMemoryPersistenceStore();
    store.appendOps = async () => {
      throw new Error("simulated DB failure");
    };

    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    const bob = fakeSocket();
    await mgr.join("doc-1", "alice", alice.socket);
    await mgr.join("doc-1", "bob", bob.socket);

    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const bobMsgs = parseSent(bob.sent);
    const broadcast = bobMsgs.find((m: { type: string }) => m.type === "broadcast-op");
    expect(broadcast).toBeDefined();
    expect(broadcast.seq).toBe(1);
    await mgr.close();
  });

  test("seq allocation failure sends error and does not apply op", async () => {
    const failingAllocator = {
      next: async () => {
        throw new Error("Redis unavailable");
      },
      current: async () => 0,
      close: async () => {},
    };

    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: failingAllocator,
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const s = fakeSocket();
    await mgr.join("doc-1", "alice", s.socket);
    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const msgs = parseSent(s.sent);
    const err = msgs.find((m: { type: string }) => m.type === "error");
    expect(err).toBeDefined();
    expect(err.code).toBe("SEQ_ALLOC_FAILED");
    await mgr.close();
  });

  test("operation order: broadcast before persist, ACK after persist", async () => {
    const events: string[] = [];
    const store = new InMemoryPersistenceStore();
    const originalAppend = store.appendOps.bind(store);
    store.appendOps = async (...args: Parameters<typeof originalAppend>) => {
      events.push("persist_start");
      const result = await originalAppend(...args);
      events.push("persist_end");
      return result;
    };

    const mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const alice = fakeSocket();
    const bob = fakeSocket();
    await mgr.join("doc-1", "alice", alice.socket);
    await mgr.join("doc-1", "bob", bob.socket);

    const originalSend = bob.socket.send;
    (bob.socket as unknown as Record<string, unknown>).send = (data: string) => {
      events.push("broadcast_to_bob");
      originalSend.call(bob.socket, data);
    };

    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const broadcastIdx = events.indexOf("broadcast_to_bob");
    const persistStartIdx = events.indexOf("persist_start");
    const persistEndIdx = events.indexOf("persist_end");

    expect(broadcastIdx).toBeGreaterThanOrEqual(0);
    expect(persistStartIdx).toBeGreaterThanOrEqual(0);
    expect(broadcastIdx).toBeLessThan(persistStartIdx);

    const aliceMsgs = parseSent(alice.sent);
    const ack = aliceMsgs.find((m: { type: string }) => m.type === "ack");
    expect(ack).toBeDefined();
    expect(persistEndIdx).toBeLessThan(events.length);

    await mgr.close();
  });
});
