import type { OpId } from "./opId.js";
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
