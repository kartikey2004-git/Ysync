import { Rga, type RgaSnapshotNode, type Op } from "@ysync/crdt";
import type { ServerMessage } from "@ysync/protocol";
import type { WebSocket } from "ws";

/**
 * Per-document in-memory state (system-design.md §6.1): the live `Rga` and
 * the sockets currently subscribed to it. Phase 3 has no persistence, so a
 * `Room` only ever reflects ops applied since it was created — that's
 * corrected in Phase 4 (cold rooms load from a Postgres snapshot instead of
 * starting empty).
 */
export class Room {
  readonly docId: string;
  private readonly rga: Rga;
  private readonly sockets = new Map<string, WebSocket>();
  private seq = 0;

  constructor(docId: string) {
    this.docId = docId;
    this.rga = new Rga(`server:${docId}`);
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
