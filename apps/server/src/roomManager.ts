import { randomUUID } from "node:crypto";
import { opIdOf, type Op } from "@ysync/crdt";
import type { PresenceEntry } from "./presence/PresenceStore.js";
import type { PresenceStore } from "./presence/PresenceStore.js";
import type { PubSubBus } from "./pubsub/PubSubBus.js";
import type { SeqAllocator } from "./seq/SeqAllocator.js";
import type { PersistenceStore } from "./persistence/PersistenceStore.js";
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
  persistenceStore: PersistenceStore;
  /** How long a presence entry stays valid without a refresh (system-design.md §6.5). */
  presenceTtlMs?: number;
  /** How often a room's presence sweep / idle-eviction / snapshot check runs. */
  sweepIntervalMs?: number;
  /** How long a room may sit empty before its in-memory state is evicted. */
  idleTimeoutMs?: number;
  /** Ops-since-last-snapshot threshold that triggers a snapshot + GC (system-design.md §6.4). */
  snapshotOpThreshold?: number;
}

function docChannel(docId: string): string {
  return `doc:${docId}`;
}

function presenceChannel(docId: string): string {
  return `presence:${docId}`;
}

/**
 * Owns every active `Room` on this process and mediates all cross-process
 * fan-out (system-design.md §6.2/§6.5) and persistence (§6.3/§6.4/§7). Each
 * published message carries this process's `processId` so its own
 * subscription can ignore it — local broadcast already happened
 * synchronously and directly; the pub/sub round trip is only for *other*
 * processes. See docs/changes/phase-3-server-core.md and
 * docs/changes/phase-4-persistence.md.
 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly processId = randomUUID();
  private readonly pubSubBus: PubSubBus;
  private readonly presenceStore: PresenceStore;
  private readonly seqAllocator: SeqAllocator;
  private readonly persistenceStore: PersistenceStore;
  private readonly presenceTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly idleTimeoutMs: number;
  private readonly snapshotOpThreshold: number;

  constructor(options: RoomManagerOptions) {
    this.pubSubBus = options.pubSubBus;
    this.presenceStore = options.presenceStore;
    this.seqAllocator = options.seqAllocator;
    this.persistenceStore = options.persistenceStore;
    this.presenceTtlMs = options.presenceTtlMs ?? 30_000;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 10_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.snapshotOpThreshold = options.snapshotOpThreshold ?? 50;
  }

  async getOrCreateRoom(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing) return existing.room;

    const { snapshot, snapshotSeq, ops, latestSeq } = await this.persistenceStore.load(docId);
    const room = Room.hydrate(docId, snapshot, snapshotSeq, ops, latestSeq);
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

  /**
   * Registers the socket in the room and decides how to catch it up
   * (system-design.md §8.3): an incremental `sync` if this room instance's
   * in-memory op log fully covers everything after `sinceSeq`, otherwise a
   * full `snapshot` fallback.
   */
  async join(
    docId: string,
    replicaId: string,
    socket: WebSocket,
    sinceSeq = 0,
  ): Promise<{ kind: "sync"; seq: number; ops: Op[] } | { kind: "snapshot"; seq: number; state: ReturnType<Room["snapshot"]> }> {
    const room = await this.getOrCreateRoom(docId);
    room.join(replicaId, socket);
    const entry = this.rooms.get(docId);
    if (entry) entry.emptySince = null;

    const incremental = room.getOpsSince(sinceSeq);
    if (incremental !== null) return { kind: "sync", seq: room.currentSeq(), ops: incremental };
    return { kind: "snapshot", seq: room.currentSeq(), state: room.snapshot() };
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

    // fan-out first (system-design.md §6.2/§6.3) — durability below must not
    // sit on the latency-critical broadcast path.
    room.broadcast({ type: "broadcast-op", docId, seq, ops }, senderReplicaId);
    const fanoutPayload: OpFanoutPayload = { originId: this.processId, seq, ops };
    await this.pubSubBus.publish(docChannel(docId), JSON.stringify(fanoutPayload));

    try {
      await this.persistenceStore.appendOps(docId, seq, ops);
      room.sendTo(senderReplicaId, { type: "ack", docId, seq, opIds: ops.map(opIdOf) });
    } catch {
      room.sendTo(senderReplicaId, {
        type: "error",
        code: "PERSIST_FAILED",
        message: "your edit was applied and shared, but could not be durably saved — it will be retried on reconnect",
      });
    }
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

    // Best-effort: a process that only saw this op via fan-out still tries
    // to persist it. Safe to be redundant with the originating process's
    // own appendOps — (docId, opId) is a unique constraint (see
    // docs/changes/phase-4-persistence.md).
    try {
      await this.persistenceStore.appendOps(docId, payload.seq, payload.ops);
    } catch {
      // the originating process is primarily responsible for durability; ignore here
    }
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

  private async snapshotRoom(docId: string): Promise<void> {
    const entry = this.rooms.get(docId);
    if (!entry) return;
    const { room } = entry;

    room.compactTombstones();
    const state = room.snapshot();
    const atSeq = room.currentSeq();
    await this.persistenceStore.writeSnapshot(docId, atSeq, state);
    room.advanceCoverageFloor(atSeq);
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

    if (entry.room.getOpsSinceSnapshot() >= this.snapshotOpThreshold) {
      await this.snapshotRoom(docId);
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
