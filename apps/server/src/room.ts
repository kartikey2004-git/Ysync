import { Rga, type RgaSnapshotNode, type Op } from "@ysync/crdt";
import type { ServerMessage } from "@ysync/protocol";
import type { OpBatch } from "./persistence/PersistenceStore.js";
import type { WebSocket } from "ws";

// Per-document in-memory state — the live Rga and whichever sockets are subscribed to it. A cold room doesn't always start empty — Room.hydrate builds one from the latest persisted snapshot plus any trailing ops.
export class Room {
  readonly docId: string;
  private readonly rga: Rga;
  private readonly sockets = new Map<string, WebSocket>();
  private seq = 0;
  private opsSinceSnapshot = 0;
  // how many ops have applied since the room was created/hydrated — needed for sinceSeq catch-up
  private opLog: OpBatch[] = [];
  // anything before coverageFloor isn't in the op history anymore, only the compacted snapshot covers it
  private coverageFloor = 0;

  constructor(docId: string, initialRga?: Rga) {
    this.docId = docId;
    this.rga = initialRga ?? new Rga(`server:${docId}`);
  }

  // rebuilds a room from a persisted snapshot (if any) plus the op batches that followed it
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

  // returns the ops after sinceSeq, or null if the gap can't be filled from memory (the caller then has to fall back to a full snapshot)
  getOpsSince(sinceSeq: number): Op[] | null {
    if (sinceSeq >= this.seq) return [];
    if (sinceSeq < this.coverageFloor) return null;
    const ops: Op[] = [];
    for (const batch of this.opLog) {
      if (batch.seq > sinceSeq) ops.push(...batch.ops);
    }
    return ops;
  }

  // If this replicaId already had a socket registered, returns it — the caller (RoomManager) can close it so it doesn't end up orphaned/unreachable.
  join(replicaId: string, socket: WebSocket): WebSocket | null {
    const previous = this.sockets.get(replicaId) ?? null;
    this.sockets.set(replicaId, socket);
    return previous;
  }

  // Only delete when a socket was passed and it still matches what's registered for this replicaId — otherwise a replaced old socket's own close event would evict the new socket that already took over this replicaId.
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

  // applies a batch, whether it originated locally or fanned in from another process, and adopts its authoritative seq
  applyOps(ops: Op[], seq: number): void {
    this.rga.applyAll(ops);
    this.seq = seq;
    this.opsSinceSnapshot += ops.length;
    this.opLog.push({ seq, ops });
  }

  getOpsSinceSnapshot(): number {
    return this.opsSinceSnapshot;
  }

  // call once a snapshot has been durably written — trims the op log and raises the coverage floor
  advanceCoverageFloor(atSeq: number): void {
    this.coverageFloor = atSeq;
    this.opLog = this.opLog.filter((batch) => batch.seq > atSeq);
    this.opsSinceSnapshot = 0;
  }

  // clears the payload on tombstoned nodes — call this right before writing a snapshot
  compactTombstones(): void {
    this.rga.compactTombstones();
  }

  sendTo(replicaId: string, message: ServerMessage): void {
    const socket = this.sockets.get(replicaId);
    // the close event may not have fired yet, so also check readyState — being in the map isn't enough
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage, exceptReplicaId?: string): void {
    const payload = JSON.stringify(message);
    for (const [replicaId, socket] of this.sockets) {
      // don't send the sender its own op back — it already gets an ack
      if (replicaId === exceptReplicaId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(payload);
    }
  }
}
