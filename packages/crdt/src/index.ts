// public surface of the package — everything else under src/ stays internal to the CRDT implementation
export { compareOpId, opIdEquals, opIdToString, opIdFromString, type OpId } from "./opId.js";
export type { FormatMark, FormatPatch, RgaNode } from "./node.js";
export type { Op, InsertOp, DeleteOp } from "./op.js";
export { opIdOf, opIdKeyOf } from "./op.js";
export { Rga, type RgaSnapshotNode, type DeltaOp } from "./rga.js";
