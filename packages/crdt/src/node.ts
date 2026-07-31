import type { OpId } from "./opId.js";

/** A single mark carried by a Peritext-style start/end marker node, e.g. `{ bold: true }`. */
export type FormatMark = Record<string, true>;

export interface RgaNode {
  id: OpId;
  /** left-neighbor id at insertion time; null means "insert at head". */
  originId: OpId | null;
  next: RgaNode | null;
  /** null once garbage-collected (tombstone skeleton, see compactTombstones). */
  value: string | null;
  tombstone: boolean;
  attrs?: FormatMark;
}
