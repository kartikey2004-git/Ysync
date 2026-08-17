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

// op ki identity: insert ho toh uski apni id, delete ho toh target id
export function opIdOf(op: Op): OpId {
  return op.type === "insert" ? op.id : op.targetId;
}

export function opIdKeyOf(op: Op): string {
  return opIdToString(opIdOf(op));
}
