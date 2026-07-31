import { Rga, type RgaSnapshotNode, type Op } from "@ysync/crdt";
import type { ServerMessage } from "@ysync/protocol";
import type { WebSocket } from "ws";

/**
 * Per-document in-memory state (system-design.md §6.1): the live `Rga` and
 * the sockets currently subscribed to it. A cold room is hydrated from its
 * latest persisted snapshot + trailing ops via `Room.hydrate` rather than
 * always starting empty (system-design.md §6.4/§7).
 */
export class Room {
  readonly docId: string;
  private readonly rga: Rga;
  private readonly sockets = new Map<string, WebSocket>();
  private seq = 0;
  private opsSinceSnapshot = 0;

  constructor(docId: string, initialRga?: Rga) {
    this.docId = docId;
    this.rga = initialRga ?? new Rga(`server:${docId}`);
  }

  /** Rebuilds a room from a persisted snapshot (if any) plus the ops recorded after it. */
  static hydrate(docId: string, snapshot: RgaSnapshotNode[], trailingOps: Op[], latestSeq: number): Room {
    const rga = snapshot.length > 0 ? Rga.fromSnapshot(snapshot, `server:${docId}`) : new Rga(`server:${docId}`);
    const room = new Room(docId, rga);
    rga.applyAll(trailingOps);
    room.seq = latestSeq;
    room.opsSinceSnapshot = trailingOps.length;
    return room;
  }

  join(replicaId: string, socket: WebSocket): void {
    this.sockets.set(replicaId, socket);
  }

  leave(replicaId: string): void {
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

  /** Applies a batch of ops (local or fanned-in from another process) and adopts the authoritative seq for the batch. */
  applyOps(ops: Op[], seq: number): void {
    this.rga.applyAll(ops);
    this.seq = seq;
    this.opsSinceSnapshot += ops.length;
  }

  getOpsSinceSnapshot(): number {
    return this.opsSinceSnapshot;
  }

  resetOpsSinceSnapshot(): void {
    this.opsSinceSnapshot = 0;
  }

  /** Clears payload from tombstoned nodes (system-design.md §4.5) — call right before writing a snapshot. */
  compactTombstones(): void {
    this.rga.compactTombstones();
  }

  sendTo(replicaId: string, message: ServerMessage): void {
    const socket = this.sockets.get(replicaId);
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  broadcast(message: ServerMessage, exceptReplicaId?: string): void {
    const payload = JSON.stringify(message);
    for (const [replicaId, socket] of this.sockets) {
      if (replicaId === exceptReplicaId) continue;
      if (socket.readyState !== socket.OPEN) continue;
      socket.send(payload);
    }
  }
}
