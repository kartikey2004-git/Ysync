import type { OpId } from "./opId.js";

// the set of active formatting marks on a single character, e.g. { bold: true }
export type FormatMark = Record<string, true>;

// what a format request carries: `true` to add a mark, `null`/`false` to remove one —
// matches how Quill Delta expresses attribute removal (e.g. { bold: null } to unbold).
export type FormatPatch = Record<string, true | null | false>;

export interface RgaNode {
  id: OpId;
  // the left-neighbor id at insertion time; null means "insert at the head"
  originId: OpId | null;
  next: RgaNode | null;
  // becomes null once garbage-collected (tombstone skeleton, see compactTombstones)
  value: string | null;
  tombstone: boolean;
  // the formatting marks active on this node's own character (undefined/empty = plain text)
  attrs?: FormatMark;
  // per-mark last-writer-wins bookkeeping: the id of the FormatOp that most recently
  // decided each key in `attrs` (or decided to clear it) — lets two concurrent format
  // ops on the same character converge on the same winner instead of "last applied wins"
  formatClock?: Record<string, OpId>;
}
