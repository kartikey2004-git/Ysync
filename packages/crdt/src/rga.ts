import { compareOpId, opIdToString, type OpId } from "./opId.js";
import type { FormatMark, FormatPatch, RgaNode } from "./node.js";
import type { DeleteOp, FormatOp, InsertOp, Op } from "./op.js";

export interface RgaSnapshotNode {
  id: OpId;
  originId: OpId | null;
  // null once this is a compacted tombstone skeleton (see Rga#compactTombstones)
  value: string | null;
  tombstone: boolean;
  attrs?: FormatMark;
  formatClock?: Record<string, OpId>;
}

export interface DeltaOp {
  insert: string;
  attributes?: FormatMark;
}

// crypto.randomUUID is not guaranteed everywhere this runs (older browsers, some test runners), so fall back to a plain random string rather than making replica creation throw.
function defaultReplicaId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

// Isomorphic RGA (Replicated Growable Array) sequence CRDT.

// localInsert/localDelete are the index-based API the editor binding calls for the local user's own edits; they return an Op meant to go out on the wire / get appended to the log. apply is the entry point for replication — whether the op came in over the network or is being replayed from the offline outbox. It's idempotent and buffers ops whose dependency hasn't arrived yet until it does.
export class Rga {
  readonly replicaId: string;
  private head: RgaNode | null = null;
  private readonly nodesById = new Map<string, RgaNode>();
  private readonly pending = new Map<string, Op[]>();
  private counter = 0;

  constructor(replicaId: string = defaultReplicaId()) {
    this.replicaId = replicaId;
  }

  localInsert(index: number, value: string, attrs?: FormatMark): InsertOp {
    // the new node attaches "after" the node before index — origin is always the left neighbor
    const anchor = this.findNodeAtPosition(index - 1);
    const op: InsertOp = {
      type: "insert",
      id: this.nextId(),
      originId: anchor ? anchor.id : null,
      value,
      attrs,
    };
    this.integrate(anchor, op);
    return op;
  }

  // Marks the node as a tombstone instead of unlinking it — other replicas may still reference this node as an insert origin, so the list structure has to stay intact.
  localDelete(index: number): DeleteOp {
    const node = this.findNodeAtPosition(index);
    if (node === null) {
      throw new Error(`no node at index ${index}`);
    }
    node.tombstone = true;
    return { type: "delete", targetId: node.id };
  }

  // Idempotent — applies a remote/replayed op in causal order.
  apply(op: Op): void {
    const queue: Op[] = [op];
    while (queue.length > 0) {
      const current = queue.shift() as Op;

      if (current.type === "insert") {
        const idKey = opIdToString(current.id);
        if (this.nodesById.has(idKey)) continue; // already applied this op, don't redo it

        // origin hasn't arrived yet — don't wait to resend this op, just buffer it
        const originKey = current.originId ? opIdToString(current.originId) : null;
        if (originKey !== null && !this.nodesById.has(originKey)) {
          this.bufferOn(originKey, current);
          continue;
        }

        const anchor = originKey !== null ? (this.nodesById.get(originKey) as RgaNode) : null;
        this.integrate(anchor, current);
        this.counter = Math.max(this.counter, current.id.counter);
        // now that this node has landed, replay whatever ops were waiting on it
        queue.push(...this.takeBuffered(idKey));
      } else if (current.type === "delete") {
        const targetKey = opIdToString(current.targetId);
        const target = this.nodesById.get(targetKey);
        if (target === undefined) {
          this.bufferOn(targetKey, current);
          continue;
        }
        target.tombstone = true;
      } else {
        const targetKey = opIdToString(current.targetId);
        const target = this.nodesById.get(targetKey);
        if (target === undefined) {
          this.bufferOn(targetKey, current);
          continue;
        }
        this.applyFormatOp(target, current);
        this.counter = Math.max(this.counter, current.id.counter);
      }
    }
  }

  applyAll(ops: Op[]): void {
    for (const op of ops) this.apply(op);
  }

  // Walks the linked list in id order, which is the same order every replica converges to, so this always produces the current document text regardless of edit history.
  read(): string {
    let result = "";
    let node = this.head;
    while (node !== null) {
      if (!node.tombstone && node.value !== null) {
        result += node.value;
      }
      node = node.next;
    }
    return result;
  }

  // Produces Quill-Delta-shaped output by coalescing consecutive characters that share
  // the same formatting marks into a single attributed run.
  getContentsForEditor(): DeltaOp[] {
    const content: DeltaOp[] = [];
    let node = this.head;
    let runText = "";
    let runAttrs: FormatMark | undefined;

    const flush = () => {
      if (runText.length === 0) return;
      content.push(runAttrs ? { insert: runText, attributes: runAttrs } : { insert: runText });
      runText = "";
    };

    while (node !== null) {
      if (!node.tombstone && node.value !== null) {
        if (!attrsEqual(node.attrs, runAttrs)) {
          flush();
          runAttrs = node.attrs;
        }
        runText += node.value;
      }
      node = node.next;
    }
    flush();
    content.push({ insert: "\n" }); // Quill delta requires a trailing newline or Quill complains
    return content;
  }

  // Retroactively applies a format patch (Quill's { bold: true } to add / { bold: null }
  // to remove) to the `length` visible characters starting at `startIndex`. Each mark on
  // each character becomes its own FormatOp targeting that character's existing node id —
  // deliberately *not* delete+reinsert, which was tried first and silently duplicates
  // characters when two replicas format overlapping ranges concurrently (see git history /
  // test/rga.test.ts "concurrent formatting"). Mutating attrs in place via LWW keeps the
  // node identity — and therefore the document length — untouched by formatting.
  localFormat(startIndex: number, length: number, patch: FormatPatch): FormatOp[] {
    const ops: FormatOp[] = [];
    for (let i = 0; i < length; i++) {
      const target = this.findNodeAtPosition(startIndex + i);
      if (target === null) break; // range extends past the end of the document

      for (const [mark, raw] of Object.entries(patch)) {
        const op: FormatOp = {
          type: "format",
          id: this.nextId(),
          targetId: target.id,
          mark,
          value: raw ? true : null,
        };
        this.applyFormatOp(target, op);
        ops.push(op);
      }
    }
    return ops;
  }

  // Applies one mark's LWW decision to a node: the format op with the greatest id (its
  // own id doubles as its timestamp) wins for that (node, mark) pair, so replaying ops in
  // any order — or replaying the same op twice — converges to the same result.
  private applyFormatOp(target: RgaNode, op: FormatOp): void {
    const clock = target.formatClock ?? (target.formatClock = {});
    const decidedBy = clock[op.mark];
    if (decidedBy !== undefined && compareOpId(decidedBy, op.id) >= 0) return;
    clock[op.mark] = op.id;

    if (op.value === true) {
      target.attrs = { ...target.attrs, [op.mark]: true };
    } else if (target.attrs && op.mark in target.attrs) {
      const nextAttrs = { ...target.attrs };
      delete nextAttrs[op.mark];
      target.attrs = Object.keys(nextAttrs).length > 0 ? nextAttrs : undefined;
    }
  }

  toSnapshot(): RgaSnapshotNode[] {
    const out: RgaSnapshotNode[] = [];
    let node = this.head;
    while (node !== null) {
      out.push({
        id: node.id,
        originId: node.originId,
        value: node.value,
        tombstone: node.tombstone,
        attrs: node.attrs,
        formatClock: node.formatClock,
      });
      node = node.next;
    }
    return out;
  }

  // Rebuilds the list directly from the ordered snapshot instead of replaying every insert/delete op — snapshots are already in final list order, so this just relinks them. counter is seeded from the highest id seen (node ids *and* formatClock ids — a format op can carry a higher counter than any insert if formatting happened after the document stopped growing) so new local ops never collide with ids that already exist in the snapshot.
  static fromSnapshot(snapshot: RgaSnapshotNode[], replicaId?: string): Rga {
    const rga = new Rga(replicaId);
    let prev: RgaNode | null = null;
    let maxCounter = 0;
    for (const s of snapshot) {
      const node: RgaNode = {
        id: s.id,
        originId: s.originId,
        next: null,
        value: s.value,
        tombstone: s.tombstone,
        attrs: s.attrs,
        formatClock: s.formatClock,
      };
      rga.nodesById.set(opIdToString(s.id), node);
      if (prev === null) {
        rga.head = node;
      } else {
        prev.next = node;
      }
      prev = node;
      maxCounter = Math.max(maxCounter, s.id.counter);
      if (s.formatClock) {
        for (const clockId of Object.values(s.formatClock)) {
          maxCounter = Math.max(maxCounter, clockId.counter);
        }
      }
    }
    rga.counter = maxCounter;
    return rga;
  }

  // Clears the payload on tombstoned nodes, leaving just the id/originId skeleton — the node can't be removed outright since a later insert may still reference it as an origin.
  compactTombstones(): void {
    let node = this.head;
    while (node !== null) {
      if (node.tombstone) {
        node.value = null;
        node.attrs = undefined;
        node.formatClock = undefined;
      }
      node = node.next;
    }
  }

  private nextId(): OpId {
    // each replica keeps its own counter; paired with replicaId it becomes globally unique
    this.counter += 1;
    return { counter: this.counter, replicaId: this.replicaId };
  }

  private bufferOn(key: string, op: Op): void {
    const existing = this.pending.get(key);
    if (existing) {
      existing.push(op);
    } else {
      this.pending.set(key, [op]);
    }
  }

  private takeBuffered(key: string): Op[] {
    const ops = this.pending.get(key);
    if (!ops) return [];
    this.pending.delete(key);
    return ops;
  }

  // Links the new node in after anchor (its recorded origin). This is the classical RGA integration rule: scan right from the origin, and keep crossing over any node whose id is strictly greater, regardless of that node's own origin. It's tempting to "optimize" this — only compare direct same-origin siblings and explicitly skip descendant subtrees — it looks equivalent but isn't: it lets an unrelated concurrent sibling end up inside another origin's not-yet-fully-arrived subtree depending on delivery order, which breaks convergence. (This exact bug was caught by test/convergence.property.test.ts — if you're ever tempted to "simplify" this again, check the git history for the counter-example.) The plain greater-id-anywhere-in-the-scan rule is what the RGA paper (Attiya et al.) specifies, and it's what keeps the total order consistent across every replica no matter what order ops are delivered in.
  private integrate(anchor: RgaNode | null, op: InsertOp): RgaNode {
    const newNode: RgaNode = {
      id: op.id,
      originId: op.originId,
      next: null,
      value: op.value,
      tombstone: false,
      attrs: op.attrs,
    };
    this.nodesById.set(opIdToString(op.id), newNode);

    let left = anchor;
    let right = anchor ? anchor.next : this.head;

    // keep advancing while the id ahead is greater than ours — this is what makes the total order deterministic
    while (right !== null && compareOpId(right.id, op.id) > 0) {
      left = right;
      right = right.next;
    }

    newNode.next = right;
    if (left === null) {
      this.head = newNode;
    } else {
      left.next = newNode;
    }
    return newNode;
  }

  private findNodeAtPosition(position: number): RgaNode | null {
    if (position < 0) return null;

    // tombstoned nodes don't count toward visible text positions — skip over them
    let node = this.head;
    while (node !== null && node.tombstone) {
      node = node.next;
    }

    let i = 0;
    while (i < position && node !== null) {
      node = node.next;
      while (node !== null && node.tombstone) {
        node = node.next;
      }
      i++;
    }
    return node;
  }
}

// order-independent comparison of two attribute sets — both are plain { mark: true } maps
function attrsEqual(a: FormatMark | undefined, b: FormatMark | undefined): boolean {
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => b !== undefined && b[key] === true);
}
