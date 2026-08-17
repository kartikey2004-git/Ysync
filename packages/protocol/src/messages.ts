import { z } from "zod";
import { opIdSchema, opSchema } from "./op.js";
import { rgaSnapshotNodeSchema } from "./rgaSnapshot.js";

const docId = z.string().min(1);
const replicaId = z.string().min(1);
const seq = z.number().int().nonnegative();

const selectionSchema = z
  .object({
    anchor: z.number().int().nonnegative(),
    head: z.number().int().nonnegative(),
  })
  .nullable();

// yeh awareness fields client ke presence message aur server ke presence-update broadcast dono mein common hain
const awarenessFields = {
  cursor: z.number().int().nonnegative().nullable().optional(),
  selection: selectionSchema.optional(),
  name: z.string().optional(),
  color: z.string().optional(),
};

// ---- client -> server ----

export const joinMessageSchema = z.object({
  type: z.literal("join"),
  docId,
  replicaId,
  sinceSeq: seq,
});

export const opMessageSchema = z.object({
  type: z.literal("op"),
  docId,
  ops: z.array(opSchema).min(1),
});

export const presenceMessageSchema = z.object({
  type: z.literal("presence"),
  docId,
  ...awarenessFields,
});

export const leaveMessageSchema = z.object({
  type: z.literal("leave"),
  docId,
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  joinMessageSchema,
  opMessageSchema,
  presenceMessageSchema,
  leaveMessageSchema,
]);

export type JoinMessage = z.infer<typeof joinMessageSchema>;
export type OpMessage = z.infer<typeof opMessageSchema>;
export type PresenceMessage = z.infer<typeof presenceMessageSchema>;
export type LeaveMessage = z.infer<typeof leaveMessageSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ---- server -> client ----

export const snapshotMessageSchema = z.object({
  type: z.literal("snapshot"),
  docId,
  seq,
  state: z.array(rgaSnapshotNodeSchema),
});

export const syncMessageSchema = z.object({
  type: z.literal("sync"),
  docId,
  seq,
  ops: z.array(opSchema),
});

export const ackMessageSchema = z.object({
  type: z.literal("ack"),
  docId,
  seq,
  opIds: z.array(opIdSchema),
});

export const broadcastOpMessageSchema = z.object({
  type: z.literal("broadcast-op"),
  docId,
  seq,
  ops: z.array(opSchema),
});

export const presenceUpdateMessageSchema = z.object({
  type: z.literal("presence-update"),
  docId,
  replicaId,
  ...awarenessFields,
});

export const presenceLeaveMessageSchema = z.object({
  type: z.literal("presence-leave"),
  docId,
  replicaId,
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const serverMessageSchema = z.discriminatedUnion("type", [
  snapshotMessageSchema,
  syncMessageSchema,
  ackMessageSchema,
  broadcastOpMessageSchema,
  presenceUpdateMessageSchema,
  presenceLeaveMessageSchema,
  errorMessageSchema,
]);

export type SnapshotMessage = z.infer<typeof snapshotMessageSchema>;
export type SyncMessage = z.infer<typeof syncMessageSchema>;
export type AckMessage = z.infer<typeof ackMessageSchema>;
export type BroadcastOpMessage = z.infer<typeof broadcastOpMessageSchema>;
export type PresenceUpdateMessage = z.infer<typeof presenceUpdateMessageSchema>;
export type PresenceLeaveMessage = z.infer<typeof presenceLeaveMessageSchema>;
export type ErrorMessage = z.infer<typeof errorMessageSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;
