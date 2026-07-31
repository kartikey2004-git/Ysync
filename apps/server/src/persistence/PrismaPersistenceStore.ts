import { opIdFromString, opIdToString, type FormatMark, type Op, type RgaSnapshotNode } from "@ysync/crdt";
import { createPrismaClient, type Prisma, type PrismaClient } from "@ysync/database";
import { opIdKeyOf } from "../util/opId.js";
import type { LoadedDocument, PersistenceStore } from "./PersistenceStore.js";

interface OperationRow {
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

/** Real Postgres-backed PersistenceStore (system-design.md §7), via `@ysync/database`. */
export class PrismaPersistenceStore implements PersistenceStore {
  private readonly prisma: PrismaClient;

  constructor(databaseUrl: string) {
    this.prisma = createPrismaClient(databaseUrl);
  }

  async load(docId: string): Promise<LoadedDocument> {
    const document = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!document) return { snapshot: [], snapshotSeq: 0, ops: [], latestSeq: 0 };

    const latestSnapshot = await this.prisma.snapshot.findFirst({
      where: { docId },
      orderBy: { atSeq: "desc" },
    });
    const snapshotSeq = latestSnapshot?.atSeq ?? 0;
    const snapshot = (latestSnapshot?.state as unknown as RgaSnapshotNode[] | undefined) ?? [];

    const opRows = await this.prisma.operation.findMany({
      where: { docId, seq: { gt: snapshotSeq } },
      orderBy: [{ seq: "asc" }, { id: "asc" }],
    });

    return { snapshot, snapshotSeq, ops: opRows.map(fromRow), latestSeq: document.latestSeq };
  }

  async appendOps(docId: string, seq: number, ops: Op[]): Promise<void> {
    if (ops.length === 0) return;
    await this.prisma.$transaction([
      this.prisma.document.upsert({
        where: { id: docId },
        create: { id: docId, latestSeq: seq },
        update: { latestSeq: seq },
      }),
      this.prisma.operation.createMany({
        data: ops.map((op) => toRow(docId, seq, op)),
        skipDuplicates: true,
      }),
    ]);
  }

  async writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.snapshot.create({
        data: { docId, atSeq, state: state as unknown as Prisma.InputJsonValue },
      }),
      this.prisma.operation.deleteMany({ where: { docId, seq: { lte: atSeq } } }),
    ]);
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}
