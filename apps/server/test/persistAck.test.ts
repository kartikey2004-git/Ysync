import { afterEach, describe, expect, test } from "vitest";
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

const insertOp = (counter: number, replicaId: string): Op => ({
  type: "insert",
  id: { counter, replicaId },
  originId: null,
  value: "x",
});

describe("Persistence → ACK ordering", () => {
  let mgr: RoomManager | undefined;

  afterEach(async () => {
    await mgr?.close();
    mgr = undefined;
  });

  test("ACK is sent only after persistence succeeds", async () => {
    const store = new InMemoryPersistenceStore();
    mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const { socket, sent } = fakeSocket();
    await mgr.join("doc-1", "alice", socket);

    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const messages = sent.map((s) => JSON.parse(s));
    const ack = messages.find((m: { type: string }) => m.type === "ack");
    expect(ack).toBeDefined();
    expect(ack.seq).toBe(1);

    const loaded = await store.load("doc-1");
    expect(loaded.latestSeq).toBeGreaterThanOrEqual(1);
  });

  test("persistence failure sends PERSIST_FAILED error instead of ACK", async () => {
    const store = new InMemoryPersistenceStore();
    const originalAppend = store.appendOps.bind(store);
    store.appendOps = async () => {
      throw new Error("DB unavailable");
    };

    mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const { socket, sent } = fakeSocket();
    await mgr.join("doc-1", "alice", socket);

    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const messages = sent.map((s) => JSON.parse(s));
    const ack = messages.find((m: { type: string }) => m.type === "ack");
    expect(ack).toBeUndefined();

    const error = messages.find(
      (m: { type: string; code?: string }) => m.type === "error" && m.code === "PERSIST_FAILED",
    );
    expect(error).toBeDefined();
  });

  test("seq allocation failure sends SEQ_ALLOC_FAILED error", async () => {
    const seqAllocator = new InMemorySeqAllocator(new InMemorySeqCounter());
    seqAllocator.next = async () => {
      throw new Error("Redis down");
    };

    mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator,
      persistenceStore: new InMemoryPersistenceStore(),
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const { socket, sent } = fakeSocket();
    await mgr.join("doc-1", "alice", socket);

    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);

    const messages = sent.map((s) => JSON.parse(s));
    const error = messages.find(
      (m: { type: string; code?: string }) => m.type === "error" && m.code === "SEQ_ALLOC_FAILED",
    );
    expect(error).toBeDefined();
  });

  test("broadcast reaches other clients even when persist fails", async () => {
    const store = new InMemoryPersistenceStore();
    store.appendOps = async () => {
      throw new Error("DB unavailable");
    };

    mgr = new RoomManager({
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

    const bobMessages = bob.sent.map((s) => JSON.parse(s));
    const broadcastOp = bobMessages.find((m: { type: string }) => m.type === "broadcast-op");
    expect(broadcastOp).toBeDefined();
  });

  test("persistence succeeds after temporary failure on retry", async () => {
    const store = new InMemoryPersistenceStore();
    let shouldFail = true;
    const originalAppend = store.appendOps.bind(store);
    store.appendOps = async (docId, seq, ops) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("temporary failure");
      }
      return originalAppend(docId, seq, ops);
    };

    mgr = new RoomManager({
      pubSubBus: new InMemoryPubSubBus(),
      presenceStore: new InMemoryPresenceStore(),
      seqAllocator: new InMemorySeqAllocator(new InMemorySeqCounter()),
      persistenceStore: store,
      sweepIntervalMs: 60_000,
      idleTimeoutMs: 60_000,
    });

    const { socket, sent } = fakeSocket();
    await mgr.join("doc-1", "alice", socket);

    await mgr.applyClientOp("doc-1", "alice", [insertOp(1, "alice")]);
    const firstMessages = sent.map((s) => JSON.parse(s));
    expect(firstMessages.some((m: { code?: string }) => m.code === "PERSIST_FAILED")).toBe(true);

    await mgr.applyClientOp("doc-1", "alice", [insertOp(2, "alice")]);
    const allMessages = sent.map((s) => JSON.parse(s));
    expect(allMessages.some((m: { type: string }) => m.type === "ack")).toBe(true);
  });
});
