import { opIdKeyOf, type Op, type RgaSnapshotNode } from "@ysync/crdt";
import type { LoadedDocument, OpBatch, PersistenceStore } from "./PersistenceStore.js";

interface StoredOp {
  seq: number;
  op: Op;
}

interface DocState {
  latestSeq: number;
  ops: StoredOp[];
  seenOpIds: Set<string>;
  snapshot: { atSeq: number; state: RgaSnapshotNode[] } | null;
}

function emptyDoc(): DocState {
  return { latestSeq: 0, ops: [], seenOpIds: new Set(), snapshot: null };
}

// groups consecutive rows with the same seq into a batch (insertion order is already seq-ordered)
function groupBySeq(rows: StoredOp[]): OpBatch[] {
  const batches: OpBatch[] = [];
  for (const row of rows) {
    const last = batches[batches.length - 1];
    if (last && last.seq === row.seq) {
      last.ops.push(row.op);
    } else {
      batches.push({ seq: row.seq, ops: [row.op] });
    }
  }
  return batches;
}

// In-memory version of Document/Operation/Snapshot, following the same contract as PrismaPersistenceStore
export class InMemoryPersistenceStore implements PersistenceStore {
  private readonly docs = new Map<string, DocState>();

  async load(docId: string): Promise<LoadedDocument> {
    const doc = this.docs.get(docId);
    if (!doc) return { snapshot: [], snapshotSeq: 0, ops: [], latestSeq: 0 };

    return {
      snapshot: doc.snapshot?.state ?? [],
      snapshotSeq: doc.snapshot?.atSeq ?? 0,
      ops: groupBySeq(doc.ops),
      latestSeq: doc.latestSeq,
    };
  }

  async appendOps(docId: string, seq: number, ops: Op[]): Promise<void> {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = emptyDoc();
      this.docs.set(docId, doc);
    }
    doc.latestSeq = Math.max(doc.latestSeq, seq);

    for (const op of ops) {
      const opIdKey = opIdKeyOf(op);
      if (doc.seenOpIds.has(opIdKey)) continue; // the same op arriving twice shouldn't save a duplicate — mirrors Postgres's unique constraint + skipDuplicates
      doc.seenOpIds.add(opIdKey);
      doc.ops.push({ seq, op });
    }
  }

  async writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void> {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = emptyDoc();
      this.docs.set(docId, doc);
    }
    doc.snapshot = { atSeq, state };
    // ops older than the snapshot are redundant now — drop them or the list just keeps growing
    doc.ops = doc.ops.filter((row) => row.seq > atSeq);
    doc.latestSeq = Math.max(doc.latestSeq, atSeq);
  }

  async close(): Promise<void> {
    this.docs.clear();
  }
}
