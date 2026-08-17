import type { Op, RgaSnapshotNode } from "@ysync/crdt";

export interface OpBatch {
  seq: number;
  ops: Op[];
}

export interface LoadedDocument {
  // latest compacted snapshot, ya [] agar document ka kabhi snapshot liya hi nahi
  snapshot: RgaSnapshotNode[];
  // jis seq pe snapshot liya tha (0 agar snapshot hai hi nahi)
  snapshotSeq: number;
  // snapshot ke baad ke saare ops, jis batch mein originally submit hue thay
  // usi seq se grouped — Room.hydrate ko yeh batch boundaries chahiye sinceSeq
  // catch-up ke liye, sirf flattened op list se kaam nahi chalega.
  ops: OpBatch[];
  // document ka latest known seq (Document.latestSeq se), us room ke liye jiske paas koi ops hi nahi hain
  latestSeq: number;
}

// Documents ke liye durable storage. RoomManager isko write path (ops append
// karna, periodic snapshot+GC) aur cold-room hydration (join ke waqt) dono ke liye use karta hai.
//
// koi bhi process jo ek op dekhe — chahe usne khud generate na kiya ho — woh
// appendOps call kar sakta hai; implementation ko yeh safe banana padega (op ki
// identity, @ysync/crdt ke opIdKeyOf se, natural dedup key hai).
export interface PersistenceStore {
  load(docId: string): Promise<LoadedDocument>;
  appendOps(docId: string, seq: number, ops: Op[]): Promise<void>;
  // atSeq pe snapshot likhta hai aur ab-redundant ops (seq <= atSeq) delete kar deta hai
  writeSnapshot(docId: string, atSeq: number, state: RgaSnapshotNode[]): Promise<void>;
  close(): Promise<void>;
}
