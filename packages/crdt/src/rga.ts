import { compareOpId, opIdToString, type OpId } from "./opId.js";
import type { FormatMark, RgaNode } from "./node.js";
import type { DeleteOp, InsertOp, Op } from "./op.js";

export interface RgaSnapshotNode {
  id: OpId;
  originId: OpId | null;
  // compacted tombstone skeleton ho toh yeh null hoga (Rga#compactTombstones dekho)
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

// Isomorphic RGA (Replicated Growable Array) sequence CRDT hai.
//
// localInsert/localDelete index-based API hai jo editor binding local user
// ke apne edits ke liye call karta hai; yeh Op return karte hain jo wire pe
// bhejna hai / log mein append karna hai. apply replication ka entry point
// hai — network se aaye ho ya offline outbox se replay ho rahe hon, dono ke
// liye. Yeh idempotent hai aur jin ops ki dependency abhi tak nahi aayi
// unhe causally buffer kar leta hai.
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
    // naya node index se pehle wale node ke "baad" jud raha hai — origin hamesha left-neighbor hota hai
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

  // idempotent hai, aur causally-ordered tareeke se remote/replayed op apply karta hai
  apply(op: Op): void {
    const queue: Op[] = [op];
    while (queue.length > 0) {
      const current = queue.shift() as Op;

      if (current.type === "insert") {
        const idKey = opIdToString(current.id);
        if (this.nodesById.has(idKey)) continue; // yeh op pehle hi apply ho chuka hai, dobara mat karo

        // origin abhi tak nahi aaya — is op ko wapas bhejne ka wait mat karo, bas buffer kar do
        const originKey = current.originId ? opIdToString(current.originId) : null;
        if (originKey !== null && !this.nodesById.has(originKey)) {
          this.bufferOn(originKey, current);
          continue;
        }

        const anchor = originKey !== null ? (this.nodesById.get(originKey) as RgaNode) : null;
        this.integrate(anchor, current);
        this.counter = Math.max(this.counter, current.id.counter);
        // ab jab yeh node aa gaya, jo ops isi pe wait kar rahe thay unhe bhi queue mein daal do
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
      // attrs wale marker nodes actual text nahi hain, format boundary hain — inko text mein mat jodo
      if (!node.tombstone && !node.attrs && node.value !== null) {
        result += node.value;
      }
      node = node.next;
    }
    return result;
  }

  // Quill-Delta-shaped output deta hai, Peritext-style marker nodes ko attribute runs mein badal ke
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
        // marker node mila — matlab ya toh ek format run band ho raha hai ya khul raha hai
        if (activeAttribute !== "") {
          // format band ho raha hai — ab tak ka tempContent us attribute ke saath push karo
          content.push({ insert: tempContent, attributes: { [activeAttribute]: true } });
          activeAttribute = "";
        } else {
          // naya format shuru ho raha hai — usse pehle ka plain tempContent push kar do
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
    content.push({ insert: "\n" }); // Quill delta ko trailing newline chahiye hi, warna Quill complain karta hai
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

  // tombstoned nodes ka payload clear kar deta hai, sirf id/originId skeleton bacha rehta hai —
  // node hata nahi sakte, baad ka koi insert isko origin ke taur pe reference kar sakta hai
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
    // counter har replica apna alag rakhta hai, replicaId ke saath milke globally unique id ban jaati hai
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

  // anchor (uska recorded origin) ke baad naya node link karta hai. Yeh classical
  // RGA integration rule hai: origin se right scan karo, jis bhi node ka id
  // strictly greater hai usko cross karte raho, chahe uska origin kuch bhi ho.
  // Yahan "optimize" karne ka mann karega — sirf direct same-origin siblings
  // compare karo aur descendant subtrees explicitly skip kar do — dikhne mein
  // same lagega par hai nahi: isse ek unrelated concurrent sibling doosre
  // origin ke not-yet-fully-arrived subtree ke andar ghus sakta hai, delivery
  // order pe depend karke, aur convergence toot jaayegi. (Yeh bug property
  // test test/convergence.property.test.ts ne pakda tha — agar kabhi phir
  // "simplify" karne ka mann kare toh git history mein counter-example dekh
  // lena.) Yeh plain greater-id-anywhere-in-the-scan rule hi RGA paper
  // (Attiya et al.) mein diya hai, aur isi se total order har replica pe
  // consistent rehta hai, delivery order chahe kuch bhi ho.
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

    // jitna aage tak id humse bada hai utna aage badho — isi se total order deterministic banta hai
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

    // tombstoned aur marker (attrs) nodes visible text mein count nahi hote, unko skip karte chalo
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
