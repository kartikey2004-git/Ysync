import { randomUUID } from "node:crypto";
import { opIdOf, opIdKeyOf, type Op } from "@ysync/crdt";
import type { PresenceEntry } from "./presence/PresenceStore.js";
import type { PresenceStore } from "./presence/PresenceStore.js";
import type { PubSubBus } from "./pubsub/PubSubBus.js";
import type { SeqAllocator } from "./seq/SeqAllocator.js";
import type { PersistenceStore } from "./persistence/PersistenceStore.js";
import { Room } from "./room.js";
import type { WebSocket } from "ws";
import { logger, errorMeta, summarizeOpIds } from "./logger.js";

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
  // how long a presence entry stays valid without a refresh
  presenceTtlMs?: number;
  // how often a room's presence sweep / idle-eviction / snapshot check runs
  sweepIntervalMs?: number;
  // how long a room stays empty before its in-memory state gets dropped
  idleTimeoutMs?: number;
  // this many ops since the last snapshot triggers a new snapshot + GC
  snapshotOpThreshold?: number;
}

function docChannel(docId: string): string {
  return `doc:${docId}`;
}

function presenceChannel(docId: string): string {
  return `presence:${docId}`;
}

// Every active Room in this process is controlled through this class, and it also manages cross-process fan-out and persistence. Every published message carries its own processId so the subscriber side can skip its own echo — the local broadcast has already happened synchronously, the pub/sub round trip is only for other Cloud Run instances.
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
    // already in memory, no need to reload from Postgres
    const existing = this.rooms.get(docId);
    if (existing) {
      logger.debug("room reused", { docId, roomCount: this.rooms.size });
      return existing.room;
    }

    let snapshot, snapshotSeq, ops, latestSeq;
    try {
      ({ snapshot, snapshotSeq, ops, latestSeq } = await this.persistenceStore.load(docId));
    } catch (err) {
      // Postgres is down or the query failed — don't crash here, wrap the error and let it propagate
      logger.error("persistenceStore.load failed", { docId, error: errorMeta(err) });
      throw new Error(`failed to load document ${docId} from persistence`);
    }
    logger.debug("document loaded from persistence", {
      docId,
      opBatchCount: ops.length,
      snapshotSeq,
      latestSeq,
      hasSnapshot: snapshot.length > 0,
    });

    const room = Room.hydrate(docId, snapshot, snapshotSeq, ops, latestSeq);
    const entry: RoomEntry = {
      room,
      emptySince: null,
      sweepTimer: setInterval(() => {
        void this.tick(docId);
      }, this.sweepIntervalMs),
    };
    this.rooms.set(docId, entry);

    try {
      await this.pubSubBus.subscribe(docChannel(docId), (raw) => {
        void this.handleRemoteOp(docId, raw);
      });
      await this.pubSubBus.subscribe(presenceChannel(docId), (raw) => {
        void this.handleRemotePresence(docId, raw);
      });
    } catch (err) {
      // subscribe failing means leaving the room half-created is wrong — clean up both the sweepTimer and the map entry, or it leaks
      logger.error("pubSubBus.subscribe failed", { docId, error: errorMeta(err) });
      clearInterval(entry.sweepTimer);
      this.rooms.delete(docId);
      throw new Error(`failed to subscribe to pub/sub channels for document ${docId}`);
    }

    logger.info("room created", { docId, roomCount: this.rooms.size, latestSeq });
    return room;
  }

  // Registers the socket on the room and decides how to send catch-up: incremental sync if the in-memory op log covers everything after sinceSeq, otherwise a full snapshot as a fallback.
  async join(
    docId: string,
    replicaId: string,
    socket: WebSocket,
    sinceSeq = 0,
  ): Promise<{ kind: "sync"; seq: number; ops: Op[] } | { kind: "snapshot"; seq: number; state: ReturnType<Room["snapshot"]> }> {
    logger.debug("roomManager join start", { docId, replicaId, sinceSeq });
    const room = await this.getOrCreateRoom(docId);
    const previousSocket = room.join(replicaId, socket);
    if (previousSocket && previousSocket !== socket && previousSocket.readyState === previousSocket.OPEN) {
      // a previous socket was already joined under this replicaId (duplicate tab, or a reconnect whose close event hasn't arrived yet) — close it so it doesn't end up orphaned/unreachable. Room.leave's identity check (room.ts) makes sure this socket's own close event won't evict the new one that just took over.
      logger.warn("closing previous socket for replicaId (replaced by a new connection)", { docId, replicaId });
      previousSocket.close(4000, "replaced by a newer connection for this replicaId");
    }
    logger.info("client added", { docId, replicaId, clientCount: room.replicaIds().length });
    const entry = this.rooms.get(docId);
    if (entry) entry.emptySince = null;

    const incremental = room.getOpsSince(sinceSeq);
    const result: { kind: "sync"; seq: number; ops: Op[] } | { kind: "snapshot"; seq: number; state: ReturnType<Room["snapshot"]> } =
      incremental !== null
        ? { kind: "sync", seq: room.currentSeq(), ops: incremental }
        : { kind: "snapshot", seq: room.currentSeq(), state: room.snapshot() };
    logger.debug("roomManager join done", { docId, replicaId, kind: result.kind, seq: result.seq });
    return result;
  }

  // emptySince gets set here, and tick() checks it against idleTimeoutMs — that's what decides when a room gets evicted (no cross-process signal needed)
  async leave(docId: string, replicaId: string, socket?: WebSocket): Promise<void> {
    const entry = this.rooms.get(docId);
    entry?.room.leave(replicaId, socket);
    logger.info("client removed", { docId, replicaId, clientCount: entry?.room.replicaIds().length ?? 0 });
    if (entry?.room.isEmpty()) {
      entry.emptySince = Date.now();
      logger.info("room emptied", { docId });
    }
    await this.removePresence(docId, replicaId);
  }

  async applyClientOp(docId: string, senderReplicaId: string, ops: Op[]): Promise<void> {
    const room = await this.getOrCreateRoom(docId);
    const opIds = ops.map(opIdKeyOf);

    let seq: number;
    try {
      seq = await this.seqAllocator.next(docId);
    } catch (err) {
      // Redis is down, so a seq can't be allocated — better to tell the client to retry than to silently drop the op
      logger.error("seqAllocator.next failed", { docId, replicaId: senderReplicaId, error: errorMeta(err) });
      room.sendTo(senderReplicaId, {
        type: "error",
        code: "SEQ_ALLOC_FAILED",
        message: "could not allocate a sequence number for your edit — it was not applied, please retry",
      });
      return;
    }

    room.applyOps(ops, seq);
    logger.debug("operation applied to room", { docId, replicaId: senderReplicaId, seq, ...summarizeOpIds(opIds) });

    // broadcast first, persist second — the user needs to see their own edit immediately, it shouldn't wait on DB write latency
    room.broadcast({ type: "broadcast-op", docId, seq, ops }, senderReplicaId);
    const fanoutPayload: OpFanoutPayload = { originId: this.processId, seq, ops };
    try {
      await this.pubSubBus.publish(docChannel(docId), JSON.stringify(fanoutPayload));
      logger.debug("operation published", { docId, channel: docChannel(docId), seq, ...summarizeOpIds(opIds) });
    } catch (err) {
      // a failed publish is fine — local clients already got the broadcast, and persistence is tried below. Only *other* instances' clients miss this op until their next resync
      logger.error("pubSubBus.publish failed", { docId, replicaId: senderReplicaId, seq, error: errorMeta(err) });
    }

    try {
      await this.persistenceStore.appendOps(docId, seq, ops);
      logger.info("operation persisted", { docId, replicaId: senderReplicaId, seq, ...summarizeOpIds(opIds) });
      room.sendTo(senderReplicaId, { type: "ack", docId, seq, opIds: ops.map(opIdOf) });
    } catch (err) {
      // the Postgres save failed, but the edit was already broadcast — no data loss, just tell the client it'll be retried on reconnect (it'll come back from the outbox)
      logger.error("failed to persist operation", {
        docId,
        replicaId: senderReplicaId,
        seq,
        ...summarizeOpIds(opIds),
        error: errorMeta(err),
      });
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

    try {
      await this.presenceStore.set(docId, entry, this.presenceTtlMs);
    } catch (err) {
      // if presence didn't save to Redis, don't broadcast either — stale/wrong state isn't better
      logger.error("presenceStore.set failed", { docId, replicaId: senderReplicaId, error: errorMeta(err) });
      return;
    }
    // debug, not info — every connected client heartbeats roughly every 8s, info level would flood the logs
    logger.debug("presence update", { docId, replicaId: senderReplicaId });

    room.broadcast({ type: "presence-update", docId, ...entry }, senderReplicaId);

    const payload: PresenceFanoutPayload = { originId: this.processId, kind: "update", entry };
    try {
      await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
    } catch (err) {
      logger.error("pubSubBus.publish (presence) failed", { docId, replicaId: senderReplicaId, error: errorMeta(err) });
    }
  }

  // same local-broadcast + cross-process fan-out pattern as updatePresence, just for the leave case — other instances need to know too, or their clients keep seeing a stale cursor
  async removePresence(docId: string, replicaId: string): Promise<void> {
    try {
      await this.presenceStore.remove(docId, replicaId);
    } catch (err) {
      logger.error("presenceStore.remove failed", { docId, replicaId, error: errorMeta(err) });
    }

    this.rooms.get(docId)?.room.broadcast({ type: "presence-leave", docId, replicaId }, replicaId);

    const payload: PresenceFanoutPayload = { originId: this.processId, kind: "leave", replicaId };
    try {
      await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
    } catch (err) {
      logger.error("pubSubBus.publish (presence leave) failed", { docId, replicaId, error: errorMeta(err) });
    }
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
    try {
      const payload = JSON.parse(raw) as OpFanoutPayload;
      // this is our own published message — already applied and broadcast it, don't redo it
      if (payload.originId === this.processId) return;

      const entry = this.rooms.get(docId);
      // no local room on this process means no local sockets either — nobody to notify
      if (!entry) return;
      entry.room.applyOps(payload.ops, payload.seq);
      entry.room.broadcast({ type: "broadcast-op", docId, seq: payload.seq, ops: payload.ops });
      logger.info("remote operation delivered", {
        docId,
        seq: payload.seq,
        ...summarizeOpIds(payload.ops.map(opIdKeyOf)),
        originId: payload.originId,
      });

      // best-effort persist for an op that arrived via fan-out too — the originating process should already have saved it, and the (docId, opId) unique constraint makes a repeat insert safe, it won't duplicate
      try {
        await this.persistenceStore.appendOps(docId, payload.seq, payload.ops);
      } catch (err) {
        // fine if this fails — the originating process already owns durability for this op
        logger.debug("redundant appendOps from fan-out failed (expected if already persisted by origin)", {
          docId,
          seq: payload.seq,
          error: errorMeta(err),
        });
      }
    } catch (err) {
      logger.error("handleRemoteOp failed", { docId, error: errorMeta(err) });
    }
  }

  private async handleRemotePresence(docId: string, raw: string): Promise<void> {
    try {
      const payload = JSON.parse(raw) as PresenceFanoutPayload;
      // same rule here: skip our own echo in the presence flow too
      if (payload.originId === this.processId) return;

      const entry = this.rooms.get(docId);
      if (!entry) return;
      if (payload.kind === "update") {
        entry.room.broadcast({ type: "presence-update", docId, ...payload.entry });
      } else {
        entry.room.broadcast({ type: "presence-leave", docId, replicaId: payload.replicaId });
      }
    } catch (err) {
      logger.error("handleRemotePresence failed", { docId, error: errorMeta(err) });
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
    logger.info("snapshot persisted", { docId, atSeq, nodeCount: state.length });
  }

  private async tick(docId: string): Promise<void> {
    const entry = this.rooms.get(docId);
    if (!entry) return;

    try {
      // a heartbeat TTL expiring means the client disconnected without sending a clean leave — clean these replicaIds up with a presence-leave too
      const expired = await this.presenceStore.sweep(docId);
      for (const replicaId of expired) {
        entry.room.broadcast({ type: "presence-leave", docId, replicaId });
        const payload: PresenceFanoutPayload = { originId: this.processId, kind: "leave", replicaId };
        await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
      }

      // crossing the threshold triggers a snapshot, otherwise the Operation table just keeps growing forever
      if (entry.room.getOpsSinceSnapshot() >= this.snapshotOpThreshold) {
        await this.snapshotRoom(docId);
      }

      if (entry.room.isEmpty()) {
        entry.emptySince ??= Date.now();
        // past the idle timeout, drop the room's in-memory state — if a client shows up later, getOrCreateRoom just reloads it from Postgres, no data loss. Only clearInterval/delete *after* both unsubscribes succeed — doing it before would mean that if one unsubscribe fails (the outer catch swallows it, no retry), the sweepTimer would already be dead and this room would stay stale forever, never evicted or retried.
        if (Date.now() - entry.emptySince >= this.idleTimeoutMs) {
          await this.pubSubBus.unsubscribe(docChannel(docId));
          await this.pubSubBus.unsubscribe(presenceChannel(docId));
          clearInterval(entry.sweepTimer);
          this.rooms.delete(docId);
          logger.info("room evicted (idle timeout)", { docId, roomCount: this.rooms.size });
        }
      } else {
        entry.emptySince = null;
      }
    } catch (err) {
      // this runs inside a setInterval with nothing awaiting it — a thrown error here would crash the process directly, so the try/catch is mandatory
      logger.error("tick failed", { docId, error: errorMeta(err) });
    }
  }
}
