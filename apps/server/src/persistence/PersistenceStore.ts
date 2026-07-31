import type { Op, RgaSnapshotNode } from "@ysync/crdt";

export interface LoadedDocument {
  /** Latest compacted snapshot, or [] if the document has never been snapshotted. */
  snapshot: RgaSnapshotNode[];
  /** The seq the snapshot was taken at (0 if there is no snapshot). */
  snapshotSeq: number;
  /** Every op recorded after the snapshot, in order. */
  ops: Op[];
  /** The document's latest known seq (from Document.latestSeq), for a room with no ops at all. */
  latestSeq: number;
}

/**
 * Durable storage for documents (system-design.md §6.3/§6.4/§7). `RoomManager`
 * uses this for both the write path (append ops, periodic snapshot+GC) and
 * cold-room hydration on `join`.
 *
 * Every process that observes an op — not just the one that originated it —
 * may call `appendOps` for it; implementations must make this safe (an op's
 * identity, from `@ysync/crdt`'s `opIdKeyOf`, is the natural dedup key).
 */
export interface PersistenceStore {
  load(docId: string): Promise<LoadedDocument>;
  appendOps(docId: string, seq: number, ops: Op[]): Promise<void>;
  /** Writes a snapshot at `atSeq` and deletes now-redundant ops (seq <= atSeq). */
  writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void>;
  close(): Promise<void>;
}
