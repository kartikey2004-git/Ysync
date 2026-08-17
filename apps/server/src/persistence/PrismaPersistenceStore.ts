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

// ek jaisi seq wali consecutive rows batch mein group kar deta hai (query pehle se seq order mein hai)
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

// Real Postgres-backed PersistenceStore hai, @ysync/database ke through
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
      // yahan error ko swallow nahi karna — Postgres down hai toh caller ko pata chalna chahiye
      logger.error("document lookup failed", { docId, error: errorMeta(err) });
      throw err;
    }
    logger.debug("document lookup", { docId, found: document !== null });
    // naya docId hai, DB mein kabhi save hi nahi hua — khali document treat karo, error nahi
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

      // snapshot ke baad ke ops hi chahiye — usse pehle wale toh snapshot mein already compact ho chuke hain
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
      // document.latestSeq aur Operation rows dono ek saath commit hone chahiye —
      // agar upsert ho gaya par rows nahi (ya ulta), toh room rehydrate hote waqt
      // ya toh galat seq maan lega ya ops silently drop ho jayenge next load pe.
      //
      // latestSeq ko GREATEST se set karna zaroori hai, plain assignment se nahi
      // — do concurrent appendOps calls (alag senders) Redis se seq N
      // aur N+1 allocate kar sakte hain lekin unki independent transactions
      // kisi bhi order mein commit ho sakti hain; agar N+1 pehle commit ho aur N
      // baad mein, plain `update: { latestSeq: seq }` latestSeq ko N pe regress
      // kar deta — GREATEST isse rok deta hai. updatedAt yahan explicitly set
      // karna padta hai kyunki raw SQL Prisma ke `@updatedAt` auto-behavior ko
      // bypass kar deta hai, aur us column ka koi DB-level default bhi nahi hai.
      
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
      // yahan bhi throw karna zaroori hai — caller (roomManager) ko client ko PERSIST_FAILED bolna hai
      logger.error("failed to persist operation", { docId, seq, ...summarizeOpIds(opIds), error: errorMeta(err) });
      throw err;
    }
    logger.debug("operation persisted (db transaction committed)", { docId, seq, ...summarizeOpIds(opIds) });
  }

  async writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void> {
    logger.debug("persisting snapshot", { docId, atSeq, nodeCount: state.length });
    try {
      // snapshot pehle land hona chahiye, tabhi purane ops delete karo — warna
      // beech mein crash hua toh woh seq range ka data hamesha ke liye gaya,
      // na snapshot bacha na raw ops
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
