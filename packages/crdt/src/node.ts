import type { OpId } from "./opId.js";

// a single mark on a Peritext-style start/end marker node, e.g. { bold: true }
export type FormatMark = Record<string, true>;

export interface RgaNode {
  id: OpId;
  // the left-neighbor id at insertion time; null means "insert at the head"
  originId: OpId | null;
  next: RgaNode | null;
  // becomes null once garbage-collected (tombstone skeleton, see compactTombstones)
  value: string | null;
  tombstone: boolean;
  attrs?: FormatMark;
}
