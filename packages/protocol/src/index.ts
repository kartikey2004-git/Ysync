// apps/web aur apps/server ke beech WS pe jo bhi value jaati hai uske liye zod schemas + inferred types
export { opIdSchema, formatMarkSchema, insertOpSchema, deleteOpSchema, opSchema } from "./op.js";
export type { OpIdShape, FormatMarkShape, InsertOpShape, DeleteOpShape, OpShape } from "./op.js";

export { rgaSnapshotNodeSchema } from "./rgaSnapshot.js";
export type { RgaSnapshotNodeShape } from "./rgaSnapshot.js";

export {
  joinMessageSchema,
  opMessageSchema,
  presenceMessageSchema,
  leaveMessageSchema,
  clientMessageSchema,
  snapshotMessageSchema,
  syncMessageSchema,
  ackMessageSchema,
  broadcastOpMessageSchema,
  presenceUpdateMessageSchema,
  presenceLeaveMessageSchema,
  errorMessageSchema,
  serverMessageSchema,
} from "./messages.js";
export type {
  JoinMessage,
  OpMessage,
  PresenceMessage,
  LeaveMessage,
  ClientMessage,
  SnapshotMessage,
  SyncMessage,
  AckMessage,
  BroadcastOpMessage,
  PresenceUpdateMessage,
  PresenceLeaveMessage,
  ErrorMessage,
  ServerMessage,
} from "./messages.js";

export { parseClientMessage, parseServerMessage } from "./parse.js";
export type { ParseResult } from "./parse.js";
