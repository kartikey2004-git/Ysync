import { z } from "zod";

/** Mirrors @ysync/crdt's `OpId`. */
export const opIdSchema = z.object({
  counter: z.number().int().nonnegative(),
  replicaId: z.string().min(1),
});

/** Mirrors @ysync/crdt's `FormatMark`. */
export const formatMarkSchema = z.record(z.literal(true));

export const insertOpSchema = z.object({
  type: z.literal("insert"),
  id: opIdSchema,
  originId: opIdSchema.nullable(),
  value: z.string(),
  attrs: formatMarkSchema.optional(),
});

export const deleteOpSchema = z.object({
  type: z.literal("delete"),
  targetId: opIdSchema,
});

/** Mirrors @ysync/crdt's `Op` union. */
export const opSchema = z.discriminatedUnion("type", [insertOpSchema, deleteOpSchema]);

export type OpIdShape = z.infer<typeof opIdSchema>;
export type FormatMarkShape = z.infer<typeof formatMarkSchema>;
export type InsertOpShape = z.infer<typeof insertOpSchema>;
export type DeleteOpShape = z.infer<typeof deleteOpSchema>;
export type OpShape = z.infer<typeof opSchema>;
