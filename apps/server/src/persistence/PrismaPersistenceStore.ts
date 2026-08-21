import {
  opIdFromString,
  opIdKeyOf,
  opIdToString,
  type FormatMark,
  type Op,
  type RgaSnapshotNode,
} from "@ysync/crdt";
import { createPrismaClient, type Prisma, type PrismaClient } from "@ysync/database";
import type { LoadedDocument, OpBatch, PersistenceStore } from "./PersistenceStore.js";
import { logger, errorMeta, summarizeOpIds } from "../logger.js";

interface OperationRow {
  seq: number;
  opId: string;
  type: string;
  originId: string | null;
  value: string | null;
  attrs: Prisma.JsonValue | null;
}

function toRow(docId: string, seq: number, op: Op) {
  const opId = opIdKeyOf(op);
  if (op.type === "insert") {
    return {
      docId,
      seq,
      opId,
      type: "insert",
      originId: op.originId ? opIdToString(op.originId) : null,
      value: op.value,
      attrs: (op.attrs ?? null) as Prisma.InputJsonValue | null,
    };
  }
  return { docId, seq, opId, type: "delete", originId: null, value: null, attrs: null };
}

function fromRow(row: OperationRow): Op {
  const id = opIdFromString(row.opId);
  if (row.type === "insert") {
    return {
      type: "insert",
      id,
      originId: row.originId ? opIdFromString(row.originId) : null,
      value: row.value ?? "",
      attrs: (row.attrs as FormatMark | null) ?? undefined,
    };
  }
  return { type: "delete", targetId: id };
}

// groups consecutive rows with the same seq into a batch (the query is already seq-ordered)
function groupBySeq(rows: OperationRow[]): OpBatch[] {
  const batches: OpBatch[] = [];
  for (const row of rows) {
    const op = fromRow(row);
    const last = batches[batches.length - 1];
    if (last && last.seq === row.seq) {
      last.ops.push(op);
    } else {
      batches.push({ seq: row.seq, ops: [op] });
    }
  }
  return batches;
}

// Real Postgres-backed PersistenceStore, via @ysync/database.
export class PrismaPersistenceStore implements PersistenceStore {
  private readonly prisma: PrismaClient;

  constructor(databaseUrl: string) {
    this.prisma = createPrismaClient(databaseUrl);
    logger.info("persistence store initialized");
  }

  async load(docId: string): Promise<LoadedDocument> {
    let document;
    try {
      document = await this.prisma.document.findUnique({ where: { id: docId } });
    } catch (err) {
      // don't swallow this error — the caller needs to know Postgres is down
      logger.error("document lookup failed", { docId, error: errorMeta(err) });
      throw err;
    }
    logger.debug("document lookup", { docId, found: document !== null });
    // a brand new docId that was never saved to the DB — treat it as an empty document, not an error
    if (!document) return { snapshot: [], snapshotSeq: 0, ops: [], latestSeq: 0 };

    let latestSnapshot;
    let opRows;
    try {
      latestSnapshot = await this.prisma.snapshot.findFirst({
        where: { docId },
        orderBy: { atSeq: "desc" },
      });
      const snapshotSeq = latestSnapshot?.atSeq ?? 0;
      logger.debug("snapshot lookup", { docId, found: latestSnapshot !== null, snapshotSeq });

      // only the ops after the snapshot are needed — anything before is already compacted into it
      opRows = await this.prisma.operation.findMany({
        where: { docId, seq: { gt: snapshotSeq } },
        orderBy: [{ seq: "asc" }, { id: "asc" }],
      });
      logger.debug("operation lookup", { docId, rowCount: opRows.length, sinceSeq: snapshotSeq });
    } catch (err) {
      logger.error("snapshot/operation lookup failed", { docId, error: errorMeta(err) });
      throw err;
    }

    const snapshotSeq = latestSnapshot?.atSeq ?? 0;
    const snapshot = (latestSnapshot?.state as unknown as RgaSnapshotNode[] | undefined) ?? [];
    return { snapshot, snapshotSeq, ops: groupBySeq(opRows), latestSeq: document.latestSeq };
  }

  async appendOps(docId: string, seq: number, ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    const opIds = ops.map(opIdKeyOf);
    logger.debug("persisting operation", { docId, seq, ...summarizeOpIds(opIds) });
    try {
      // document.latestSeq and the Operation rows must commit together — if the upsert lands but the rows don't (or vice versa), a room rehydrating later either assumes the wrong seq or silently drops ops on the next load.

      // latestSeq has to be set with GREATEST, not a plain assignment — two concurrent appendOps calls (different senders) can allocate seq N and N+1 from Redis but their independent transactions can commit in either order; if N+1 commits first and N commits after, a plain `update: { latestSeq: seq }` would regress latestSeq back to N — GREATEST prevents that. updatedAt has to be set explicitly here because the raw SQL bypasses Prisma's `@updatedAt` auto-behavior, and that column has no DB-level default either.

      await this.prisma.$transaction([
        this.prisma.$executeRaw`
          INSERT INTO "Document" ("id", "latestSeq", "updatedAt")
          VALUES (${docId}, ${seq}, now())
          ON CONFLICT ("id") DO UPDATE
          SET "latestSeq" = GREATEST("Document"."latestSeq", EXCLUDED."latestSeq"),
              "updatedAt" = now()
        `,
        this.prisma.operation.createMany({
          data: ops.map((op) => toRow(docId, seq, op)),
          skipDuplicates: true,
        }),
      ]);
    } catch (err) {
      // this has to throw too — the caller (roomManager) needs to tell the client PERSIST_FAILED
      logger.error("failed to persist operation", { docId, seq, ...summarizeOpIds(opIds), error: errorMeta(err) });
      throw err;
    }
    logger.debug("operation persisted (db transaction committed)", { docId, seq, ...summarizeOpIds(opIds) });
  }

  async writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void> {
    logger.debug("persisting snapshot", { docId, atSeq, nodeCount: state.length });
    try {
      // the snapshot has to land first, only then delete the old ops — otherwise a crash in between loses that seq range's data entirely, neither the snapshot nor the raw ops survive
      await this.prisma.$transaction([
        this.prisma.snapshot.create({
          data: { docId, atSeq, state: state as unknown as Prisma.InputJsonValue },
        }),
        this.prisma.operation.deleteMany({ where: { docId, seq: { lte: atSeq } } }),
      ]);
    } catch (err) {
      logger.error("failed to persist snapshot", { docId, atSeq, error: errorMeta(err) });
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
