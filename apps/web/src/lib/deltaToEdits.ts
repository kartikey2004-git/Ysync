// Converts a Quill Delta into an ordered list of index-based edits, matching
// @ysync/crdt's char-at-a-time Rga API.
//
// Deliberately kept pure and dependency-free of the Quill *library* (no `import Quill`)
// — this is the one piece of the editor binding that's worth unit testing directly. It
// does import @ysync/crdt's types, which is fine — no runtime dependency, just shapes.
//
// Only boolean-style attributes (bold: true, bold: null/false to clear — Quill's own
// convention) are forwarded; anything else (color, header level, link href, ...) isn't
// representable by @ysync/crdt's FormatMark yet, so those keys are silently dropped
// rather than mishandled. Non-string ("embed") inserts are skipped but still advance the
// cursor by one, since Quill's delta counts them as a position too.

import type { FormatMark, FormatPatch } from "@ysync/crdt";

export interface DeltaOp {
  insert?: string | Record<string, unknown>;
  delete?: number;
  retain?: number;
  attributes?: Record<string, unknown>;
}

export interface QuillDelta {
  ops: DeltaOp[];
}

export type Edit =
  | { kind: "insert"; index: number; value: string; attrs?: FormatMark }
  | { kind: "delete"; index: number }
  | { kind: "format"; index: number; length: number; attrs: FormatPatch };

// keeps only { key: true } pairs — what a fresh insert's attributes describe (you can't
// insert a character "un-bold", only bold or not-mentioned)
function toFormatMark(attributes: Record<string, unknown> | undefined): FormatMark | undefined {
  if (!attributes) return undefined;
  const mark: FormatMark = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === true) mark[key] = true;
  }
  return Object.keys(mark).length > 0 ? mark : undefined;
}

// keeps { key: true } and normalizes Quill's false/null "clear this mark" into null —
// FormatPatch's own convention
function toFormatPatch(attributes: Record<string, unknown> | undefined): FormatPatch | undefined {
  if (!attributes) return undefined;
  const patch: FormatPatch = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === true) patch[key] = true;
    else if (value === false || value === null) patch[key] = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

export function deltaToEdits(delta: QuillDelta): Edit[] {
  const edits: Edit[] = [];
  let cursor = 0;

  for (const op of delta.ops) {
    if (typeof op.retain === "number") {
      const patch = toFormatPatch(op.attributes);
      if (patch) {
        edits.push({ kind: "format", index: cursor, length: op.retain, attrs: patch });
      }
      cursor += op.retain;
      continue;
    }

    if (typeof op.insert === "string") {
      const attrs = toFormatMark(op.attributes);
      for (const char of op.insert) {
        edits.push(attrs ? { kind: "insert", index: cursor, value: char, attrs } : { kind: "insert", index: cursor, value: char });
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
