import { Rga, type RgaSnapshotNode, type Op } from "@ysync/crdt";
import type { ServerMessage } from "@ysync/protocol";
import type { OpBatch } from "./persistence/PersistenceStore.js";
import type { WebSocket } from "ws";

// Per-document in-memory state — live Rga aur jo sockets isse subscribed hain.
// Cold room hamesha khali shuru nahi hoti, Room.hydrate se latest persisted
// snapshot + baaki trailing ops load karke bani hoti hai.
export class Room {
  readonly docId: string;
  private readonly rga: Rga;
  private readonly sockets = new Map<string, WebSocket>();
  private seq = 0;
  private opsSinceSnapshot = 0;
  // yeh room banne/hydrate hone ke baad se jitne ops apply hue, sinceSeq catch-up ke liye chahiye
  private opLog: OpBatch[] = [];
  // coverageFloor se pehle ka poora op history nahi hota, sirf compacted snapshot bacha hota hai
  private coverageFloor = 0;

  constructor(docId: string, initialRga?: Rga) {
    this.docId = docId;
    this.rga = initialRga ?? new Rga(`server:${docId}`);
  }

  // persisted snapshot (agar hai) aur uske baad ke op batches se room dobara banata hai
  static hydrate(docId: string, snapshot: RgaSnapshotNode[], snapshotSeq: number, trailingOpBatches: OpBatch[], latestSeq: number): Room {
    const rga = snapshot.length > 0 ? Rga.fromSnapshot(snapshot, `server:${docId}`) : new Rga(`server:${docId}`);
    const room = new Room(docId, rga);
    const flatOps = trailingOpBatches.flatMap((batch) => batch.ops);
    rga.applyAll(flatOps);
    room.seq = latestSeq;
    room.opsSinceSnapshot = flatOps.length;
    room.opLog = trailingOpBatches.slice();
    room.coverageFloor = snapshotSeq;
    return room;
  }

  // sinceSeq ke baad ke ops de deta hai, ya null agar memory mein gap fill nahi ho sakta
  // (caller ko phir poora snapshot fallback karna padega)
  getOpsSince(sinceSeq: number): Op[] | null {
    if (sinceSeq >= this.seq) return [];
    if (sinceSeq < this.coverageFloor) return null;
    const ops: Op[] = [];
    for (const batch of this.opLog) {
      if (batch.seq > sinceSeq) ops.push(...batch.ops);
    }
    return ops;
  }

  // Agar isi replicaId ke liye pehle se koi socket registered tha, use return
  // karta hai — caller (RoomManager) usko close kar sakta hai taaki woh
  // orphaned/unreachable na reh jaaye.
  join(replicaId: string, socket: WebSocket): WebSocket | null {
    const previous = this.sockets.get(replicaId) ?? null;
    this.sockets.set(replicaId, socket);
    return previous;
  }

  // socket pass kiya gaya ho toh sirf tabhi delete karo jab woh abhi bhi
  // isi replicaId ke against registered socket ho — warna ek replaced
  // purane socket ka apna close event naye
  // socket ko evict kar dega jo already isi replicaId ko le chuka hai.
  leave(replicaId: string, socket?: WebSocket): void {
    if (socket && this.sockets.get(replicaId) !== socket) return;
    this.sockets.delete(replicaId);
  }

  hasSocket(replicaId: string): boolean {
    return this.sockets.has(replicaId);
  }

  isEmpty(): boolean {
    return this.sockets.size === 0;
  }

  replicaIds(): string[] {
    return [...this.sockets.keys()];
  }

  currentSeq(): number {
    return this.seq;
  }

  snapshot(): RgaSnapshotNode[] {
    return this.rga.toSnapshot();
  }

  // local ho ya doosre process se fan-in hua batch, dono ko apply karta hai aur uska authoritative seq apna leta hai
  applyOps(ops: Op[], seq: number): void {
    this.rga.applyAll(ops);
    this.seq = seq;
    this.opsSinceSnapshot += ops.length;
    this.opLog.push({ seq, ops });
  }

  getOpsSinceSnapshot(): number {
    return this.opsSinceSnapshot;
  }

  // snapshot durably write hone ke baad call hota hai — opLog se purana kaat do, coverage floor upar badha do
  advanceCoverageFloor(atSeq: number): void {
    this.coverageFloor = atSeq;
    this.opLog = this.opLog.filter((batch) => batch.seq > atSeq);
    this.opsSinceSnapshot = 0;
  }

  // tombstoned nodes ka payload clear karta hai — snapshot likhne se theek pehle isko call karo
  compactTombstones(): void {
    this.rga.compactTombstones();
  }

  sendTo(replicaId: string, message: ServerMessage): void {
    const socket = this.sockets.get(replicaId);
    // close event abhi tak fire nahi hua ho sakta, isliye readyState bhi check karo, sirf map mein hona kaafi nahi
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage, exceptReplicaId?: string): void {
    const payload = JSON.stringify(message);
    for (const [replicaId, socket] of this.sockets) {
      // sender ko apna hi op wapas nahi bhejna — usko already ack milega
      if (replicaId === exceptReplicaId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(payload);
    }
  }
}
