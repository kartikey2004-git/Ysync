import { describe, expect, test } from "vitest";
import type { Op } from "@ysync/crdt";
import { createPrismaClient } from "@ysync/database";
import { PrismaPersistenceStore } from "../src/persistence/PrismaPersistenceStore.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ysync";

async function isPostgresReachable(url: string): Promise<boolean> {
  const prisma = createPrismaClient(url);
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

const postgresAvailable = await isPostgresReachable(DATABASE_URL);

function insertOp(
  counter: number,
  replicaId: string,
  value: string,
  originId: { counter: number; replicaId: string } | null = null,
): Op {
  return { type: "insert", id: { counter, replicaId }, originId, value };
}

// Real Prisma/Postgres wale adapter ko test karta hai, persistence.inMemory.test.ts
// ka counterpart hai. Agar DATABASE_URL pe Postgres reachable nahi hai toh
// fail nahi, skip karta hai.
describe.skipIf(!postgresAvailable)("PrismaPersistenceStore (requires a live Postgres at DATABASE_URL)", () => {
  test("appendOps then load() round-trips through real Postgres", async () => {
    const store = new PrismaPersistenceStore(DATABASE_URL);
    const docId = `test-doc-${Date.now()}-a`;
    const opA = insertOp(1, "alice", "h");
    const opB = insertOp(2, "alice", "i", { counter: 1, replicaId: "alice" });

    await store.appendOps(docId, 1, [opA, opB]);
    const loaded = await store.load(docId);

    expect(loaded.ops).toEqual([{ seq: 1, ops: [opA, opB] }]);
    expect(loaded.latestSeq).toBe(1);
    expect(loaded.snapshot).toEqual([]);

    await store.close();
  });

  test("appendOps is idempotent for a repeated opId (unique constraint + skipDuplicates)", async () => {
    const store = new PrismaPersistenceStore(DATABASE_URL);
    const docId = `test-doc-${Date.now()}-b`;
    const op = insertOp(1, "alice", "h");

    await store.appendOps(docId, 1, [op]);
    await store.appendOps(docId, 1, [op]);

    const loaded = await store.load(docId);
    expect(loaded.ops).toEqual([{ seq: 1, ops: [op] }]);

    await store.close();
  });

  test("writeSnapshot compacts prior ops in real Postgres", async () => {
    const store = new PrismaPersistenceStore(DATABASE_URL);
    const docId = `test-doc-${Date.now()}-c`;
    const opA = insertOp(1, "alice", "h");
    await store.appendOps(docId, 1, [opA]);

    const snapshotState = [{ id: { counter: 1, replicaId: "alice" }, originId: null, value: "h", tombstone: false }];
    await store.writeSnapshot(docId, 1, snapshotState);

    const opB = insertOp(2, "alice", "i", { counter: 1, replicaId: "alice" });
    await store.appendOps(docId, 2, [opB]);

    const loaded = await store.load(docId);
    expect(loaded.snapshotSeq).toBe(1);
    expect(loaded.snapshot).toEqual(snapshotState);
    expect(loaded.ops).toEqual([{ seq: 2, ops: [opB] }]);

    await store.close();
  });

  test("document.latestSeq never regresses even if a lower-seq appendOps commits after a higher one (BUG-006)", async () => {
    const store = new PrismaPersistenceStore(DATABASE_URL);
    const docId = `test-doc-${Date.now()}-d`;

    // real usage mein yeh do alag concurrent applyClientOp calls (do senders) se
    // aate — Redis INCR seq allocation ka order guarantee karta hai, transaction
    // commit ka nahi. Yahan hum sirf woh out-of-order commit sequence directly
    // simulate kar rahe hain: pehle higher seq commit, phir lower seq.
    await store.appendOps(docId, 5, [insertOp(5, "alice", "e")]);
    await store.appendOps(docId, 3, [insertOp(3, "alice", "c")]);

    const loaded = await store.load(docId);
    expect(loaded.latestSeq).toBe(5); // GREATEST se protect hona chahiye, 3 pe regress nahi hona chahiye

    await store.close();
  });
});
