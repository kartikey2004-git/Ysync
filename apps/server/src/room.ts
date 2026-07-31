import { Rga, type RgaSnapshotNode, type Op } from "@ysync/crdt";
import type { ServerMessage } from "@ysync/protocol";
import type { OpBatch } from "./persistence/PersistenceStore.js";
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
  /** Ops applied since this room instance was created/hydrated, for `sinceSeq` catch-up (system-design.md §8.3). */
  private opLog: OpBatch[] = [];
  /** Full op history is available for seq > coverageFloor; at/before it, only the compacted snapshot exists. */
  private coverageFloor = 0;

  constructor(docId: string, initialRga?: Rga) {
    this.docId = docId;
    this.rga = initialRga ?? new Rga(`server:${docId}`);
  }

  /** Rebuilds a room from a persisted snapshot (if any) plus the op batches recorded after it. */
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

  /**
   * Ops after `sinceSeq`, or `null` if this room instance can't fill the
   * gap from memory (caller should fall back to a full snapshot).
   */
  getOpsSince(sinceSeq: number): Op[] | null {
    if (sinceSeq >= this.seq) return [];
    if (sinceSeq < this.coverageFloor) return null;
    const ops: Op[] = [];
    for (const batch of this.opLog) {
      if (batch.seq > sinceSeq) ops.push(...batch.ops);
    }
    return ops;
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
    this.opLog.push({ seq, ops });
  }

  getOpsSinceSnapshot(): number {
    return this.opsSinceSnapshot;
  }

  /** Called after a snapshot is durably written: trims opLog to what's still needed and moves the coverage floor up. */
  advanceCoverageFloor(atSeq: number): void {
    this.coverageFloor = atSeq;
    this.opLog = this.opLog.filter((batch) => batch.seq > atSeq);
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
