import { z } from "zod";
import { formatMarkSchema, opIdSchema } from "./op.js";

// @ysync/crdt ke RgaSnapshotNode ko mirror karta hai
export const rgaSnapshotNodeSchema = z.object({
  id: opIdSchema,
  originId: opIdSchema.nullable(),
  value: z.string().nullable(),
  tombstone: z.boolean(),
  attrs: formatMarkSchema.optional(),
});

export type RgaSnapshotNodeShape = z.infer<typeof rgaSnapshotNodeSchema>;
