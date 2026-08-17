// Quill Delta ko index-based edits ki ordered list mein badalta hai,
// @ysync/crdt ke char-at-a-time Rga API ke hisab se.
//
// Jaan-boojh kar pure aur dependency-free rakha hai (Quill import nahi hai) —
// editor binding ka yehi ek piece hai jo directly unit test karne layak hai.
//
// Rich-text attributes jaan-boojh kar drop kar rahe hain (packages/crdt mein
// ek known marker-node bug hai) — abhi is phase mein plain text hi chalega.
// Non-string ("embed") inserts skip ho jaate hain par cursor ek unit aage
// badha dete hain, kyunki Quill ke delta mein woh bhi ek position ginte hain.

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
      cursor += 1; // embed hai — hum handle nahi karte, par position toh occupy karta hi hai
      continue;
    }

    if (typeof op.delete === "number") {
      // har delete se position collapse ho jaati hai, isliye index kabhi aage nahi badhta
      for (let i = 0; i < op.delete; i++) {
        edits.push({ kind: "delete", index: cursor });
      }
    }
  }

  return edits;
}
