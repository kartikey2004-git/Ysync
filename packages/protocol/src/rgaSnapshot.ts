import { z } from "zod";
import { formatMarkSchema, opIdSchema } from "./op.js";

// mirrors @ysync/crdt's RgaSnapshotNode
export const rgaSnapshotNodeSchema = z.object({
  id: opIdSchema,
  originId: opIdSchema.nullable(),
  value: z.string().nullable(),
  tombstone: z.boolean(),
  attrs: formatMarkSchema.optional(),
  // per-mark LWW bookkeeping (see @ysync/crdt's RgaNode.formatClock) — must round-trip
  // through snapshots, otherwise a reloaded replica could let a stale format op win a
  // conflict that was already correctly resolved before the reload.
  formatClock: z.record(opIdSchema).optional(),
});

export type RgaSnapshotNodeShape = z.infer<typeof rgaSnapshotNodeSchema>;
