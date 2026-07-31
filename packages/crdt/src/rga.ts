import { compareOpId, opIdToString, type OpId } from "./opId.js";
import type { FormatMark, RgaNode } from "./node.js";
import type { DeleteOp, InsertOp, Op } from "./op.js";

export interface RgaSnapshotNode {
  id: OpId;
  originId: OpId | null;
  /** null for a compacted tombstone skeleton (see Rga#compactTombstones). */
  value: string | null;
  tombstone: boolean;
  attrs?: FormatMark;
}

export interface DeltaOp {
  insert: string;
  attributes?: FormatMark;
}

function defaultReplicaId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/**
 * Isomorphic RGA (Replicated Growable Array) sequence CRDT.
 *
 * `localInsert`/`localDelete` are the index-based API an editor binding
 * calls for the local user's own edits; they return the `Op` to send over
 * the wire / append to the log. `apply` is the replication entry point for
 * ops coming from the network or replayed from an offline outbox — it is
 * idempotent and causally buffers ops whose dependency hasn't arrived yet.
 */
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

  localDelete(index: number): DeleteOp {
    const node = this.findNodeAtPosition(index);
    if (node === null) {
      throw new Error(`no node at index ${index}`);
    }
    node.tombstone = true;
    return { type: "delete", targetId: node.id };
  }

  /** Idempotent, causally-ordered application of a remote or replayed op. */
  apply(op: Op): void {
    const queue: Op[] = [op];
    while (queue.length > 0) {
      const current = queue.shift() as Op;

      if (current.type === "insert") {
        const idKey = opIdToString(current.id);
        if (this.nodesById.has(idKey)) continue; // already applied

        const originKey = current.originId ? opIdToString(current.originId) : null;
        if (originKey !== null && !this.nodesById.has(originKey)) {
          this.bufferOn(originKey, current);
          continue;
        }

        const anchor = originKey !== null ? (this.nodesById.get(originKey) as RgaNode) : null;
        this.integrate(anchor, current);
        this.counter = Math.max(this.counter, current.id.counter);
        queue.push(...this.takeBuffered(idKey));
      } else {
        const targetKey = opIdToString(current.targetId);
        const target = this.nodesById.get(targetKey);
        if (target === undefined) {
          this.bufferOn(targetKey, current);
          continue;
        }
        target.tombstone = true;
      }
    }
  }

  applyAll(ops: Op[]): void {
    for (const op of ops) this.apply(op);
  }

  read(): string {
    let result = "";
    let node = this.head;
    while (node !== null) {
      if (!node.tombstone && !node.attrs && node.value !== null) {
        result += node.value;
      }
      node = node.next;
    }
    return result;
  }

  /** Quill-Delta-shaped output, translating Peritext-style marker nodes into attribute runs. */
  getContentsForEditor(): DeltaOp[] {
    const content: DeltaOp[] = [];
    let node = this.head;
    let tempContent = "";
    let activeAttribute = "";

    while (node !== null) {
      if (node.tombstone) {
        node = node.next;
        continue;
      }
      if (node.attrs) {
        if (activeAttribute !== "") {
          content.push({ insert: tempContent, attributes: { [activeAttribute]: true } });
          activeAttribute = "";
        } else {
          activeAttribute = Object.keys(node.attrs)[0] as string;
          content.push({ insert: tempContent });
        }
        tempContent = "";
      } else if (node.value !== null) {
        tempContent += node.value;
      }
      node = node.next;
    }
    content.push({ insert: tempContent });
    content.push({ insert: "\n" });
    return content;
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
      });
      node = node.next;
    }
    return out;
  }

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
      };
      rga.nodesById.set(opIdToString(s.id), node);
      if (prev === null) {
        rga.head = node;
      } else {
        prev.next = node;
      }
      prev = node;
      maxCounter = Math.max(maxCounter, s.id.counter);
    }
    rga.counter = maxCounter;
    return rga;
  }

  /** Clears payload from tombstoned nodes, keeping only the id/originId skeleton (see system-design.md §4.5). */
  compactTombstones(): void {
    let node = this.head;
    while (node !== null) {
      if (node.tombstone) {
        node.value = null;
        node.attrs = undefined;
      }
      node = node.next;
    }
  }

  private nextId(): OpId {
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

  /**
   * Links a new node after `anchor` (its recorded origin). This is the
   * classical RGA integration rule: scan right from the origin and keep
   * going past any node with a strictly greater id, regardless of that
   * node's own origin. It's tempting to "optimize" this into only
   * comparing direct same-origin siblings and explicitly skipping past
   * descendant subtrees — that looks equivalent but isn't: it lets an
   * unrelated concurrent sibling wedge itself inside another origin's
   * not-yet-fully-arrived subtree depending on delivery order, breaking
   * convergence. (Caught by the property test in
   * test/convergence.property.test.ts — see git history for the counter-
   * example if this is ever "simplified" again.) The plain
   * greater-id-anywhere-in-the-scan rule is what the RGA paper (Attiya et
   * al., already cited in docs/README.md) actually specifies, and it's
   * what makes the total order consistent across replicas independent of
   * delivery order.
   */
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

    let node = this.head;
    while (node !== null && (node.tombstone || node.attrs)) {
      node = node.next;
    }

    let i = 0;
    while (i < position && node !== null) {
      node = node.next;
      while (node !== null && (node.tombstone || node.attrs)) {
        node = node.next;
      }
      i++;
    }
    return node;
  }
}
