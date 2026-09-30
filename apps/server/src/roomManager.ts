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
import * as metrics from "./metrics.js";
import { trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("ysync-server");

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
  private readonly inFlightLoads = new Map<string, Promise<Room>>();
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
    if (existing) {
      logger.debug("room reused", { docId, roomCount: this.rooms.size });
      return existing.room;
    }

    const inflight = this.inFlightLoads.get(docId);
    if (inflight) {
      metrics.roomLoadsDeduped.inc();
      logger.debug("room load already in flight, awaiting", { docId });
      return inflight;
    }

    const loadPromise = this.loadRoom(docId);
    this.inFlightLoads.set(docId, loadPromise);
    try {
      return await loadPromise;
    } finally {
      this.inFlightLoads.delete(docId);
    }
  }

  private async loadRoom(docId: string): Promise<Room> {
    logger.info("room_load_started", { docId });
    let snapshot, snapshotSeq, ops, latestSeq;
    try {
      ({ snapshot, snapshotSeq, ops, latestSeq } = await this.persistenceStore.load(docId));
    } catch (err) {
      logger.error("room_load_failed", { docId, error: errorMeta(err) });
      metrics.roomLoadFailures.inc();
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
    metrics.activeRooms.set(this.rooms.size);

    try {
      await this.pubSubBus.subscribe(docChannel(docId), (raw) => {
        void this.handleRemoteOp(docId, raw);
      });
      await this.pubSubBus.subscribe(presenceChannel(docId), (raw) => {
        void this.handleRemotePresence(docId, raw);
      });
    } catch (err) {
      logger.error("pubSubBus.subscribe failed", { docId, error: errorMeta(err) });
      metrics.errors.inc({ stage: "subscribe" });
      clearInterval(entry.sweepTimer);
      this.rooms.delete(docId);
      throw new Error(`failed to subscribe to pub/sub channels for document ${docId}`);
    }

    logger.info("room_load_completed", { docId, roomCount: this.rooms.size, latestSeq });
    return room;
  }

  // Registers the socket on the room and decides how to send catch-up: incremental sync if the in-memory op log covers everything after sinceSeq, otherwise a full snapshot as a fallback.
  async join(
    docId: string,
    replicaId: string,
    socket: WebSocket,
    sinceSeq = 0,
    connectionId?: string,
  ): Promise<{ kind: "sync"; seq: number; ops: Op[] } | { kind: "snapshot"; seq: number; state: ReturnType<Room["snapshot"]> }> {
    logger.debug("roomManager join start", { connectionId, docId, replicaId, sinceSeq });
    const room = await this.getOrCreateRoom(docId);
    const previousSocket = room.join(replicaId, socket);
    if (previousSocket && previousSocket !== socket && previousSocket.readyState === previousSocket.OPEN) {
      logger.warn("closing previous socket for replicaId (replaced by a new connection)", { connectionId, docId, replicaId });
      previousSocket.close(4000, "replaced by a newer connection for this replicaId");
      metrics.reconnects.inc();
    }
    logger.info("client added", { connectionId, docId, replicaId, clientCount: room.replicaIds().length });
    const entry = this.rooms.get(docId);
    if (entry) entry.emptySince = null;

    const incremental = room.getOpsSince(sinceSeq);
    const result: { kind: "sync"; seq: number; ops: Op[] } | { kind: "snapshot"; seq: number; state: ReturnType<Room["snapshot"]> } =
      incremental !== null
        ? { kind: "sync", seq: room.currentSeq(), ops: incremental }
        : { kind: "snapshot", seq: room.currentSeq(), state: room.snapshot() };
    logger.debug("roomManager join done", { connectionId, docId, replicaId, kind: result.kind, seq: result.seq });
    return result;
  }

  // emptySince gets set here, and tick() checks it against idleTimeoutMs — that's what decides when a room gets evicted (no cross-process signal needed)
  async leave(docId: string, replicaId: string, socket?: WebSocket, connectionId?: string): Promise<void> {
    const entry = this.rooms.get(docId);
    entry?.room.leave(replicaId, socket);
    logger.info("client removed", { connectionId, docId, replicaId, clientCount: entry?.room.replicaIds().length ?? 0 });
    if (entry?.room.isEmpty()) {
      entry.emptySince = Date.now();
      logger.info("room emptied", { connectionId, docId });
    }
    await this.removePresence(docId, replicaId);
  }

  async applyClientOp(docId: string, senderReplicaId: string, ops: Op[], connectionId?: string): Promise<void> {
    return tracer.startActiveSpan("ysync.applyClientOp", async (span) => {
      span.setAttributes({ "ysync.doc_id": docId, "ysync.op_count": ops.length });
      try {
        const room = await this.getOrCreateRoom(docId);
        const opIds = ops.map(opIdKeyOf);
        metrics.opsReceived.inc();

        let seq: number;
        try {
          const seqEnd = metrics.redisOperationDuration.startTimer({ operation: "seq_next" });
          seq = await this.seqAllocator.next(docId);
          seqEnd();
        } catch (err) {
          logger.error("seqAllocator.next failed", { connectionId, docId, replicaId: senderReplicaId, error: errorMeta(err) });
          metrics.errors.inc({ stage: "seq_alloc" });
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          room.sendTo(senderReplicaId, {
            type: "error",
            code: "SEQ_ALLOC_FAILED",
            message: "could not allocate a sequence number for your edit — it was not applied, please retry",
          });
          return;
        }

        room.applyOps(ops, seq);
        logger.debug("operation applied to room", { connectionId, docId, replicaId: senderReplicaId, seq, ...summarizeOpIds(opIds) });

        const broadcastEnd = metrics.opBroadcastDuration.startTimer();
        room.broadcast({ type: "broadcast-op", docId, seq, ops }, senderReplicaId);
        broadcastEnd();
        metrics.opsBroadcast.inc();

        const fanoutPayload: OpFanoutPayload = { originId: this.processId, seq, ops };
        try {
          const pubEnd = metrics.redisOperationDuration.startTimer({ operation: "publish" });
          await this.pubSubBus.publish(docChannel(docId), JSON.stringify(fanoutPayload));
          pubEnd();
          logger.debug("operation published", { connectionId, docId, channel: docChannel(docId), seq, ...summarizeOpIds(opIds) });
        } catch (err) {
          metrics.errors.inc({ stage: "publish" });
          logger.error("pubSubBus.publish failed", { connectionId, docId, replicaId: senderReplicaId, seq, error: errorMeta(err) });
        }

        await tracer.startActiveSpan("ysync.persist", async (persistSpan) => {
          persistSpan.setAttributes({ "ysync.doc_id": docId, "ysync.seq": seq });
          const persistEnd = metrics.opPersistDuration.startTimer();
          try {
            await this.persistenceStore.appendOps(docId, seq, ops);
            persistEnd();
            metrics.opsPersisted.inc();
            logger.info("operation persisted", { connectionId, docId, replicaId: senderReplicaId, seq, ...summarizeOpIds(opIds) });
            room.sendTo(senderReplicaId, { type: "ack", docId, seq, opIds: ops.map(opIdOf) });
          } catch (err) {
            persistEnd();
            metrics.errors.inc({ stage: "persist" });
            logger.error("failed to persist operation", {
              connectionId,
              docId,
              replicaId: senderReplicaId,
              seq,
              ...summarizeOpIds(opIds),
              error: errorMeta(err),
            });
            persistSpan.recordException(err as Error);
            persistSpan.setStatus({ code: SpanStatusCode.ERROR });
            room.sendTo(senderReplicaId, {
              type: "error",
              code: "PERSIST_FAILED",
              message: "your edit was applied and shared, but could not be durably saved — it will be retried on reconnect",
            });
          } finally {
            persistSpan.end();
          }
        });
      } finally {
        span.end();
      }
    });
  }

  async updatePresence(docId: string, senderReplicaId: string, awareness: Omit<PresenceEntry, "replicaId">, connectionId?: string): Promise<void> {
    const room = await this.getOrCreateRoom(docId);
    const entry: PresenceEntry = { replicaId: senderReplicaId, ...awareness };
    metrics.presenceUpdates.inc();

    try {
      const presEnd = metrics.redisOperationDuration.startTimer({ operation: "presence_set" });
      await this.presenceStore.set(docId, entry, this.presenceTtlMs);
      presEnd();
    } catch (err) {
      metrics.errors.inc({ stage: "presence" });
      logger.error("presenceStore.set failed", { connectionId, docId, replicaId: senderReplicaId, error: errorMeta(err) });
      return;
    }
    logger.debug("presence update", { connectionId, docId, replicaId: senderReplicaId });

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
    for (const [docId, entry] of this.rooms.entries()) {
      clearInterval(entry.sweepTimer);
      try {
        await this.pubSubBus.unsubscribe(docChannel(docId));
        await this.pubSubBus.unsubscribe(presenceChannel(docId));
      } catch (err) {
        logger.warn("close: unsubscribe failed", { docId, error: errorMeta(err) });
      }
    }
    this.rooms.clear();
    metrics.activeRooms.set(0);
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

    return tracer.startActiveSpan("ysync.snapshot", async (span) => {
      span.setAttributes({ "ysync.doc_id": docId, "ysync.seq": room.currentSeq() });
      try {
        room.compactTombstones();
        const state = room.snapshot();
        const atSeq = room.currentSeq();
        await this.persistenceStore.writeSnapshot(docId, atSeq, state);
        room.advanceCoverageFloor(atSeq);
        metrics.snapshots.inc();
        logger.info("snapshot persisted", { docId, atSeq, nodeCount: state.length });
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
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
          metrics.activeRooms.set(this.rooms.size);
          logger.info("room evicted (idle timeout)", { docId, roomCount: this.rooms.size });
        }
      } else {
        entry.emptySince = null;
      }
    } catch (err) {
      // this runs inside a setInterval with nothing awaiting it — a thrown error here would crash the process directly, so the try/catch is mandatory
      metrics.errors.inc({ stage: "tick" });
      logger.error("tick failed", { docId, error: errorMeta(err) });
    }
  }
}
