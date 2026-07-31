import { randomUUID } from "node:crypto";
import type { Op, OpId } from "@ysync/crdt";
import type { PresenceEntry } from "./presence/PresenceStore.js";
import type { PresenceStore } from "./presence/PresenceStore.js";
import type { PubSubBus } from "./pubsub/PubSubBus.js";
import type { SeqAllocator } from "./seq/SeqAllocator.js";
import { Room } from "./room.js";
import type { WebSocket } from "ws";

interface RoomEntry {
  room: Room;
  sweepTimer: ReturnType<typeof setInterval>;
  emptySince: number | null;
}

interface OpFanoutPayload {
  originId: string;
  seq: number;
  ops: Op[];
}

type PresenceFanoutPayload =
  | { originId: string; kind: "update"; entry: PresenceEntry }
  | { originId: string; kind: "leave"; replicaId: string };

export interface RoomManagerOptions {
  pubSubBus: PubSubBus;
  presenceStore: PresenceStore;
  seqAllocator: SeqAllocator;
  /** How long a presence entry stays valid without a refresh (system-design.md §6.5). */
  presenceTtlMs?: number;
  /** How often a room's presence sweep / idle-eviction check runs. */
  sweepIntervalMs?: number;
  /** How long a room may sit empty before its in-memory state is evicted. */
  idleTimeoutMs?: number;
}

function opIdOf(op: Op): OpId {
  return op.type === "insert" ? op.id : op.targetId;
}

function docChannel(docId: string): string {
  return `doc:${docId}`;
}

function presenceChannel(docId: string): string {
  return `presence:${docId}`;
}

/**
 * Owns every active `Room` on this process and mediates all cross-process
 * fan-out (system-design.md §6.2/§6.5). Each published message carries this
 * process's `processId` so its own subscription can ignore it — local
 * broadcast already happened synchronously and directly; the pub/sub round
 * trip is only for *other* processes. See docs/changes/phase-3-server-core.md.
 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly processId = randomUUID();
  private readonly pubSubBus: PubSubBus;
  private readonly presenceStore: PresenceStore;
  private readonly seqAllocator: SeqAllocator;
  private readonly presenceTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly idleTimeoutMs: number;

  constructor(options: RoomManagerOptions) {
    this.pubSubBus = options.pubSubBus;
    this.presenceStore = options.presenceStore;
    this.seqAllocator = options.seqAllocator;
    this.presenceTtlMs = options.presenceTtlMs ?? 30_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
  }

  async getOrCreateRoom(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing) return existing.room;

    const room = new Room(docId);
    const entry: RoomEntry = {
      room,
      emptySince: null,
      sweepTimer: setInterval(() => {
        void this.tick(docId);
      }, this.sweepIntervalMs),
    };
    this.rooms.set(docId, entry);

    await this.pubSubBus.subscribe(docChannel(docId), (raw) => {
      void this.handleRemoteOp(docId, raw);
    });
    await this.pubSubBus.subscribe(presenceChannel(docId), (raw) => {
      void this.handleRemotePresence(docId, raw);
    });

    return room;
  }

  async join(docId: string, replicaId: string, socket: WebSocket): Promise<Room> {
    const room = await this.getOrCreateRoom(docId);
    room.join(replicaId, socket);
    const entry = this.rooms.get(docId);
    if (entry) entry.emptySince = null;
    return room;
  }

  async leave(docId: string, replicaId: string): Promise<void> {
    const entry = this.rooms.get(docId);
    entry?.room.leave(replicaId);
    if (entry?.room.isEmpty()) entry.emptySince = Date.now();
    await this.removePresence(docId, replicaId);
  }

  async applyClientOp(docId: string, senderReplicaId: string, ops: Op[]): Promise<void> {
    const room = await this.getOrCreateRoom(docId);
    const seq = await this.seqAllocator.next(docId);
    room.applyOps(ops, seq);

    room.sendTo(senderReplicaId, { type: "ack", docId, seq, opIds: ops.map(opIdOf) });
    room.broadcast({ type: "broadcast-op", docId, seq, ops }, senderReplicaId);

    const payload: OpFanoutPayload = { originId: this.processId, seq, ops };
    await this.pubSubBus.publish(docChannel(docId), JSON.stringify(payload));
  }

  async updatePresence(docId: string, senderReplicaId: string, awareness: Omit<PresenceEntry, "replicaId">): Promise<void> {
    const room = await this.getOrCreateRoom(docId);
    const entry: PresenceEntry = { replicaId: senderReplicaId, ...awareness };
    await this.presenceStore.set(docId, entry, this.presenceTtlMs);

    room.broadcast({ type: "presence-update", docId, ...entry }, senderReplicaId);

    const payload: PresenceFanoutPayload = { originId: this.processId, kind: "update", entry };
    await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
  }

  async removePresence(docId: string, replicaId: string): Promise<void> {
    await this.presenceStore.remove(docId, replicaId);
    this.rooms.get(docId)?.room.broadcast({ type: "presence-leave", docId, replicaId }, replicaId);

    const payload: PresenceFanoutPayload = { originId: this.processId, kind: "leave", replicaId };
    await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
  }

  async listPresence(docId: string) {
    return this.presenceStore.list(docId);
  }

  async close(): Promise<void> {
    for (const entry of this.rooms.values()) {
      clearInterval(entry.sweepTimer);
    }
    this.rooms.clear();
  }

  private async handleRemoteOp(docId: string, raw: string): Promise<void> {
    const payload = JSON.parse(raw) as OpFanoutPayload;
    if (payload.originId === this.processId) return; // already applied+broadcast directly

    const entry = this.rooms.get(docId);
    if (!entry) return; // no local room => no local sockets to notify
    entry.room.applyOps(payload.ops, payload.seq);
    entry.room.broadcast({ type: "broadcast-op", docId, seq: payload.seq, ops: payload.ops });
  }

  private async handleRemotePresence(docId: string, raw: string): Promise<void> {
    const payload = JSON.parse(raw) as PresenceFanoutPayload;
    if (payload.originId === this.processId) return;

    const entry = this.rooms.get(docId);
    if (!entry) return;
    if (payload.kind === "update") {
      entry.room.broadcast({ type: "presence-update", docId, ...payload.entry });
    } else {
      entry.room.broadcast({ type: "presence-leave", docId, replicaId: payload.replicaId });
    }
  }

  private async tick(docId: string): Promise<void> {
    const entry = this.rooms.get(docId);
    if (!entry) return;

    const expired = await this.presenceStore.sweep(docId);
    for (const replicaId of expired) {
      entry.room.broadcast({ type: "presence-leave", docId, replicaId });
      const payload: PresenceFanoutPayload = { originId: this.processId, kind: "leave", replicaId };
      await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
    }

    if (entry.room.isEmpty()) {
      entry.emptySince ??= Date.now();
      if (Date.now() - entry.emptySince >= this.idleTimeoutMs) {
        clearInterval(entry.sweepTimer);
        await this.pubSubBus.unsubscribe(docChannel(docId));
        await this.pubSubBus.unsubscribe(presenceChannel(docId));
        this.rooms.delete(docId);
      }
    } else {
      entry.emptySince = null;
    }
  }
}
