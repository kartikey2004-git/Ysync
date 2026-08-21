import type { Op, RgaSnapshotNode } from "@ysync/crdt";

export interface OpBatch {
  seq: number;
  ops: Op[];
}

export interface LoadedDocument {
  // the latest compacted snapshot, or [] if the document has never been snapshotted
  snapshot: RgaSnapshotNode[];
  // the seq the snapshot was taken at (0 if there's no snapshot at all)
  snapshotSeq: number;
  // every op after the snapshot, grouped by the seq they were originally submitted in — Room.hydrate needs these batch boundaries for sinceSeq catch-up, a flattened op list isn't enough
  ops: OpBatch[];
  // the document's latest known seq (from Document.latestSeq), for a room that has no ops of its own
  latestSeq: number;
}

// Durable storage for documents. RoomManager uses it both for the write path (appending ops, periodic snapshot+GC) and for cold-room hydration (on join).

// Any process that sees an op — even one it didn't generate itself — can call appendOps; the implementation has to make that safe (an op's identity, from @ysync/crdt's opIdKeyOf, is the natural dedup key).
export interface PersistenceStore {
  load(docId: string): Promise<LoadedDocument>;
  appendOps(docId: string, seq: number, ops: Op[]): Promise<void>;
  // writes a snapshot at atSeq and deletes the now-redundant ops (seq <= atSeq)
  writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void>;
  close(): Promise<void>;
}
