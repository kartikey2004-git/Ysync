// package ka public surface hai — src/ mein baaki sab kuch CRDT implementation ke andar hi rehta hai
export { compareOpId, opIdEquals, opIdToString, opIdFromString, type OpId } from "./opId.js";
export type { FormatMark, RgaNode } from "./node.js";
export type { Op, InsertOp, DeleteOp } from "./op.js";
export { opIdOf, opIdKeyOf } from "./op.js";
export { Rga, type RgaSnapshotNode, type DeltaOp } from "./rga.js";
