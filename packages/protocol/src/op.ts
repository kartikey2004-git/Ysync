import { z } from "zod";

// @ysync/crdt ke OpId ko mirror karta hai
export const opIdSchema = z.object({
  counter: z.number().int().nonnegative(),
  replicaId: z.string().min(1),
});

// @ysync/crdt ke FormatMark ko mirror karta hai
export const formatMarkSchema = z.record(z.literal(true));

export const insertOpSchema = z.object({
  type: z.literal("insert"),
  id: opIdSchema,
  originId: opIdSchema.nullable(),
  // normal typing produces one char per op (deltaToEdits.ts) — this cap is
  // just a ceiling for a single-op paste-as-one-string case (BUG-009)
  value: z.string().max(4000),
  attrs: formatMarkSchema.optional(),
});

export const deleteOpSchema = z.object({
  type: z.literal("delete"),
  targetId: opIdSchema,
});

// @ysync/crdt ke Op union ko mirror karta hai
export const opSchema = z.discriminatedUnion("type", [insertOpSchema, deleteOpSchema]);

export type OpIdShape = z.infer<typeof opIdSchema>;
export type FormatMarkShape = z.infer<typeof formatMarkSchema>;
export type InsertOpShape = z.infer<typeof insertOpSchema>;
export type DeleteOpShape = z.infer<typeof deleteOpSchema>;
export type OpShape = z.infer<typeof opSchema>;
