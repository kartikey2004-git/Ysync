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

export type Op = InsertOp | DeleteOp;

// an op's identity: its own id for an insert, the target's id for a delete
export function opIdOf(op: Op): OpId {
  return op.type === "insert" ? op.id : op.targetId;
}

export function opIdKeyOf(op: Op): string {
  return opIdToString(opIdOf(op));
}
