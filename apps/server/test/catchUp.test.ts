import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { RoomManager } from "../src/roomManager.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

function fakeSocket() {
  const sent: string[] = [];
  const fake = { readyState: 1, OPEN: 1, send: (data: string) => sent.push(data) };
  return { socket: fake as unknown as WebSocket, sent };
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createManager(overrides: { sweepIntervalMs?: number; snapshotOpThreshold?: number } = {}) {
  return new RoomManager({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(),
    persistenceStore: new InMemoryPersistenceStore(),
    idleTimeoutMs: 60_000,
    sweepIntervalMs: overrides.sweepIntervalMs ?? 60_000,
    snapshotOpThreshold: overrides.snapshotOpThreshold,
  });
}

// Unit tests for the sync-vs-snapshot catch-up decision — the bigger scenario test is
// in offlineReconnect.scenario.test.ts, which exercises this through a whole
// multi-client reconnect flow; here it's tested directly.
describe("RoomManager.join catch-up decision", () => {
  test("a fresh room with sinceSeq=0 returns an empty sync (nothing to catch up on)", async () => {
    const manager = createManager();
    const alice = fakeSocket();

    const result = await manager.join("doc-1", "alice", alice.socket, 0);
    expect(result).toEqual({ kind: "sync", seq: 0, ops: [] });

    await manager.close();
  });

  test("sinceSeq behind the current seq returns just the missing ops as an incremental sync", async () => {
    const manager = createManager();
    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket, 0);

    const opA = { type: "insert" as const, id: { counter: 1, replicaId: "alice" }, originId: null, value: "a" };
    const opB = {
      type: "insert" as const,
      id: { counter: 2, replicaId: "alice" },
      originId: { counter: 1, replicaId: "alice" },
      value: "b",
    };
    const opC = {
      type: "insert" as const,
      id: { counter: 3, replicaId: "alice" },
      originId: { counter: 2, replicaId: "alice" },
      value: "c",
    };
    await manager.applyClientOp("doc-1", "alice", [opA]); // seq 1
    await manager.applyClientOp("doc-1", "alice", [opB]); // seq 2
    await manager.applyClientOp("doc-1", "alice", [opC]); // seq 3

    const bob = fakeSocket();
    const result = await manager.join("doc-1", "bob", bob.socket, 1); // bob last saw up through seq 1

    expect(result).toEqual({ kind: "sync", seq: 3, ops: [opB, opC] });

    await manager.close();
  });

  test("sinceSeq already at (or ahead of) the current seq returns an empty sync", async () => {
    const manager = createManager();
    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket, 0);
    await manager.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "a" },
    ]);

    const bob = fakeSocket();
    const result = await manager.join("doc-1", "bob", bob.socket, 1); // bob is already caught up

    expect(result).toEqual({ kind: "sync", seq: 1, ops: [] });

    await manager.close();
  });

  test("a sinceSeq older than the coverage floor (after a snapshot+GC) falls back to a full snapshot", async () => {
    const manager = createManager({ sweepIntervalMs: 20, snapshotOpThreshold: 1 });
    const alice = fakeSocket();
    await manager.join("doc-1", "alice", alice.socket, 0);
    await manager.applyClientOp("doc-1", "alice", [
      { type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "a" },
    ]);
    await wait(60); // give the sweep tick time to take a snapshot and advance the coverage floor

    const bob = fakeSocket();
    const result = await manager.join("doc-1", "bob", bob.socket, 0); // bob's sinceSeq predates the snapshot

    expect(result.kind).toBe("snapshot");
    if (result.kind === "snapshot") {
      expect(result.state.map((n) => n.value)).toEqual(["a"]);
      expect(result.seq).toBe(1);
    }

    await manager.close();
  });
});
