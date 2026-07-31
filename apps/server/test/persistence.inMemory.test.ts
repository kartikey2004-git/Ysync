import { describe, expect, test } from "vitest";
import type { Op } from "@ysync/crdt";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";

function insertOp(
  counter: number,
  replicaId: string,
  value: string,
  originId: { counter: number; replicaId: string } | null = null,
): Op {
  return { type: "insert", id: { counter, replicaId }, originId, value };
}

describe("InMemoryPersistenceStore", () => {
  test("load() on an unknown doc returns empty state", async () => {
    const store = new InMemoryPersistenceStore();
    expect(await store.load("doc-1")).toEqual({ snapshot: [], snapshotSeq: 0, ops: [], latestSeq: 0 });
  });

  test("appendOps then load() round-trips the ops and latestSeq", async () => {
    const store = new InMemoryPersistenceStore();
    const opA = insertOp(1, "alice", "h");
    const opB = insertOp(2, "alice", "i", { counter: 1, replicaId: "alice" });

    await store.appendOps("doc-1", 1, [opA, opB]);

    const loaded = await store.load("doc-1");
    expect(loaded.ops).toEqual([opA, opB]);
    expect(loaded.latestSeq).toBe(1);
    expect(loaded.snapshot).toEqual([]);
    expect(loaded.snapshotSeq).toBe(0);
  });

  test("appendOps is idempotent for a repeated opId", async () => {
    const store = new InMemoryPersistenceStore();
    const op = insertOp(1, "alice", "h");

    await store.appendOps("doc-1", 1, [op]);
    await store.appendOps("doc-1", 1, [op]); // e.g. a redundant fan-in retry

    const loaded = await store.load("doc-1");
    expect(loaded.ops).toHaveLength(1);
  });

  test("writeSnapshot compacts prior ops and load() reflects the new baseline", async () => {
    const store = new InMemoryPersistenceStore();
    const opA = insertOp(1, "alice", "h");
    const opB = insertOp(2, "alice", "i", { counter: 1, replicaId: "alice" });
    await store.appendOps("doc-1", 1, [opA, opB]);

    const snapshotState = [
      { id: opA.type === "insert" ? opA.id : opA.targetId, originId: null, value: "h", tombstone: false },
    ];
    await store.writeSnapshot("doc-1", 1, snapshotState);

    const opC = insertOp(3, "alice", "!", { counter: 2, replicaId: "alice" });
    await store.appendOps("doc-1", 2, [opC]);

    const loaded = await store.load("doc-1");
    expect(loaded.snapshot).toEqual(snapshotState);
    expect(loaded.snapshotSeq).toBe(1);
    expect(loaded.ops).toEqual([opC]); // opA/opB pruned — superseded by the snapshot
    expect(loaded.latestSeq).toBe(2);
  });
});
