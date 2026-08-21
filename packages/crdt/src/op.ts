import { opIdToString, type OpId } from "./opId.js";
import type { FormatMark } from "./node.js";

export interface InsertOp {
  type: "insert";
  id: OpId;
  originId: OpId | null;
  value: string;
  attrs?: FormatMark;
}

export interface DeleteOp {
  type: "delete";
  targetId: OpId;
}

// Sets or clears one formatting mark on one existing character. `id` is this op's own
// id, used as its LWW timestamp: when two format ops race for the same (targetId, mark)
// pair, the one with the greater id wins on every replica, regardless of delivery order.
// value: true adds the mark, null removes it — mirrors Quill Delta's own convention for
// clearing an attribute (e.g. { bold: null }).
export interface FormatOp {
  type: "format";
  id: OpId;
  targetId: OpId;
  mark: string;
  value: true | null;
}

export type Op = InsertOp | DeleteOp | FormatOp;

// an op's identity: its own id for an insert/format, the target's id for a delete
export function opIdOf(op: Op): OpId {
  return op.type === "delete" ? op.targetId : op.id;
}

export function opIdKeyOf(op: Op): string {
  return opIdToString(opIdOf(op));
}
