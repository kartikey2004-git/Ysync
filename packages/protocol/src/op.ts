import { z } from "zod";

// mirrors @ysync/crdt's OpId
export const opIdSchema = z.object({
  counter: z.number().int().nonnegative(),
  replicaId: z.string().min(1),
});

// mirrors @ysync/crdt's FormatMark
export const formatMarkSchema = z.record(z.literal(true));

export const insertOpSchema = z.object({
  type: z.literal("insert"),
  id: opIdSchema,
  originId: opIdSchema.nullable(),
  // normal typing produces one char per op (deltaToEdits.ts) — this cap is
  // just a ceiling for a single-op paste-as-one-string case
  value: z.string().max(4000),
  attrs: formatMarkSchema.optional(),
});

export const deleteOpSchema = z.object({
  type: z.literal("delete"),
  targetId: opIdSchema,
});

// mirrors @ysync/crdt's FormatOp
export const formatOpSchema = z.object({
  type: z.literal("format"),
  id: opIdSchema,
  targetId: opIdSchema,
  mark: z.string().min(1).max(100),
  value: z.union([z.literal(true), z.null()]),
});

// mirrors @ysync/crdt's Op union
export const opSchema = z.discriminatedUnion("type", [insertOpSchema, deleteOpSchema, formatOpSchema]);

export type OpIdShape = z.infer<typeof opIdSchema>;
export type FormatMarkShape = z.infer<typeof formatMarkSchema>;
export type InsertOpShape = z.infer<typeof insertOpSchema>;
export type DeleteOpShape = z.infer<typeof deleteOpSchema>;
export type FormatOpShape = z.infer<typeof formatOpSchema>;
export type OpShape = z.infer<typeof opSchema>;
