import { z } from "zod";
import { formatMarkSchema, opIdSchema } from "./op.js";

// mirrors @ysync/crdt's RgaSnapshotNode
export const rgaSnapshotNodeSchema = z.object({
  id: opIdSchema,
  originId: opIdSchema.nullable(),
  value: z.string().nullable(),
  tombstone: z.boolean(),
  attrs: formatMarkSchema.optional(),
});

export type RgaSnapshotNodeShape = z.infer<typeof rgaSnapshotNodeSchema>;
