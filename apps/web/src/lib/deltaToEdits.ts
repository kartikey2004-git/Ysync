// Converts a Quill Delta into an ordered list of index-based edits, matching
// @ysync/crdt's char-at-a-time Rga API.
//
// Deliberately kept pure and dependency-free (no Quill import) — this is the one piece
// of the editor binding that's worth unit testing directly.
//
// Rich-text attributes are intentionally dropped here (there's a known marker-node bug
// in packages/crdt) — plain text only for this phase. Non-string ("embed") inserts are
// skipped but still advance the cursor by one, since Quill's delta counts them as a position too.

export interface DeltaOp {
  insert?: string | Record<string, unknown>;
  delete?: number;
  retain?: number;
  attributes?: Record<string, unknown>;
}

export interface QuillDelta {
  ops: DeltaOp[];
}

export type Edit = { kind: "insert"; index: number; value: string } | { kind: "delete"; index: number };

export function deltaToEdits(delta: QuillDelta): Edit[] {
  const edits: Edit[] = [];
  let cursor = 0;

  for (const op of delta.ops) {
    if (typeof op.retain === "number") {
      cursor += op.retain;
      continue;
    }

    if (typeof op.insert === "string") {
      for (const char of op.insert) {
        edits.push({ kind: "insert", index: cursor, value: char });
        cursor += 1;
      }
      continue;
    }

    if (op.insert !== undefined) {
      cursor += 1; // it's an embed — not handled, but it still occupies a position
      continue;
    }

    if (typeof op.delete === "number") {
      // each delete collapses that position, so the index never advances
      for (let i = 0; i < op.delete; i++) {
        edits.push({ kind: "delete", index: cursor });
      }
    }
  }

  return edits;
}
