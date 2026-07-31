import { opIdToString, type Op, type OpId } from "@ysync/crdt";

/** An op's identity: an insert's own id, or a delete's target id. */
export function opIdOf(op: Op): OpId {
  return op.type === "insert" ? op.id : op.targetId;
}

export function opIdKeyOf(op: Op): string {
  return opIdToString(opIdOf(op));
}
