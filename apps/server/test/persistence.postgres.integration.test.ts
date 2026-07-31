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

/**
 * Exercises the real Prisma/Postgres-backed adapter, as the counterpart to
 * persistence.inMemory.test.ts. Skips (rather than fails) when no Postgres
 * is reachable at DATABASE_URL — see docs/changes/phase-4-persistence.md.
 */
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
});
