/**
 * Translates a Quill Delta into an ordered list of index-based edits
 * matching `@ysync/crdt`'s char-at-a-time `Rga` API.
 *
 * Pure and dependency-free on purpose (no Quill import) — see
 * docs/changes/phase-5-web-editor.md: this is the one piece of the editor
 * binding worth unit testing directly.
 *
 * Rich-text `attributes` are intentionally dropped (see plan.md's Phase 5
 * note on packages/crdt's marker-node bug) — this phase is plain text only.
 * Non-string ("embed") inserts are skipped but still advance the cursor by
 * one unit, since Quill's delta still counts them as a single position.
 */

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
      cursor += 1; // embed — out of scope, but still occupies one position
      continue;
    }

    if (typeof op.delete === "number") {
      // each delete collapses the position, so the index never advances
      for (let i = 0; i < op.delete; i++) {
        edits.push({ kind: "delete", index: cursor });
      }
    }
  }

  return edits;
}
