import type { OpId } from "./opId.js";

// Peritext-style start/end marker node ka ek mark hai, jaise { bold: true }
export type FormatMark = Record<string, true>;

export interface RgaNode {
  id: OpId;
  // insertion ke waqt ka left-neighbor id; null matlab "head pe insert karo"
  originId: OpId | null;
  next: RgaNode | null;
  // garbage-collect hone ke baad null ho jata hai (tombstone skeleton, compactTombstones dekho)
  value: string | null;
  tombstone: boolean;
  attrs?: FormatMark;
}
