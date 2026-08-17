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
  // presence entry bina refresh ke kitni der tak valid rahega
  presenceTtlMs?: number;
  // room ka presence sweep / idle-eviction / snapshot check kitni der mein chalta hai
  sweepIntervalMs?: number;
  // room khali rehne ke baad kitni der mein uska in-memory state hata denge
  idleTimeoutMs?: number;
  // itne ops ho jaayein last snapshot ke baad toh naya snapshot + GC trigger ho jata hai
  snapshotOpThreshold?: number;
}

function docChannel(docId: string): string {
  return `doc:${docId}`;
}

function presenceChannel(docId: string): string {
  return `presence:${docId}`;
}

// Is process ke saare active Room isi class ke through control hote hain,
// cross-process fan-out aur persistence bhi yahin se manage hoti hai. Har
// published message mein apna processId bhejte hain taaki subscriber side
// pe apna hi echo skip kar sakein — local broadcast toh synchronously ho
// hi chuka hota hai, pub/sub round trip sirf dusre Cloud Run instances ke liye hai.
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
    // room already memory mein hai toh dobara Postgres se load karne ki zaroorat nahi
    const existing = this.rooms.get(docId);
    if (existing) {
      logger.debug("room reused", { docId, roomCount: this.rooms.size });
      return existing.room;
    }

    let snapshot, snapshotSeq, ops, latestSeq;
    try {
      ({ snapshot, snapshotSeq, ops, latestSeq } = await this.persistenceStore.load(docId));
    } catch (err) {
      // Postgres down hai ya query fail hui — yahan crash nahi karna, error ko wrap karke upar bhej do
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
      // Redis subscribe fail ho gaya toh room ko half-created chhod ke rakhna galat hai —
      // sweepTimer aur map entry dono clean kar do, warna leak ho jayega
      logger.error("pubSubBus.subscribe failed", { docId, error: errorMeta(err) });
      clearInterval(entry.sweepTimer);
      this.rooms.delete(docId);
      throw new Error(`failed to subscribe to pub/sub channels for document ${docId}`);
    }

    logger.info("room created", { docId, roomCount: this.rooms.size, latestSeq });
    return room;
  }

  // Socket ko room mein register karta hai aur decide karta hai kaise catch-up bhejein:
  // agar in-memory op log mein sinceSeq ke baad ka sab kuch hai toh incremental sync,
  // warna poora snapshot bhej do fallback ke taur pe.
  async join(
    docId: string,
    replicaId: string,
    socket: WebSocket,
    sinceSeq = 0,
  ): Promise<{ kind: "sync"; seq: number; ops: Op[] } | { kind: "snapshot"; seq: number; state: ReturnType<Room["snapshot"]> }> {
    logger.debug("roomManager join start", { docId, replicaId, sinceSeq });
    const room = await this.getOrCreateRoom(docId);
    room.join(replicaId, socket);
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

  async leave(docId: string, replicaId: string): Promise<void> {
    const entry = this.rooms.get(docId);
    entry?.room.leave(replicaId);
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
      // Redis down hai toh seq allocate nahi kar sakte — op ko silently drop karne se
      // achha hai client ko bata do ki retry karo
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

    // pehle broadcast, phir persist — user ko turant apna edit dikhna chahiye,
    // DB write ke latency ke liye usko rokna nahi hai
    room.broadcast({ type: "broadcast-op", docId, seq, ops }, senderReplicaId);
    const fanoutPayload: OpFanoutPayload = { originId: this.processId, seq, ops };
    try {
      await this.pubSubBus.publish(docChannel(docId), JSON.stringify(fanoutPayload));
      logger.debug("operation published", { docId, channel: docChannel(docId), seq, ...summarizeOpIds(opIds) });
    } catch (err) {
      // publish fail hua toh bhi koi baat nahi — local clients ko broadcast already mil chuka hai,
      // persistence bhi neeche try hogi. Sirf *doosre* instances ke clients ko yeh op agli resync tak nahi milega
      logger.error("pubSubBus.publish failed", { docId, replicaId: senderReplicaId, seq, error: errorMeta(err) });
    }

    try {
      await this.persistenceStore.appendOps(docId, seq, ops);
      logger.info("operation persisted", { docId, replicaId: senderReplicaId, seq, ...summarizeOpIds(opIds) });
      room.sendTo(senderReplicaId, { type: "ack", docId, seq, opIds: ops.map(opIdOf) });
    } catch (err) {
      // Postgres save fail hua, lekin edit already broadcast ho chuka hai — data loss nahi hai,
      // client ko bata do reconnect pe retry hoga (outbox se dobara aayega)
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
      // presence Redis mein save nahi hua toh broadcast bhi mat karo — stale/wrong state better nahi hai
      logger.error("presenceStore.set failed", { docId, replicaId: senderReplicaId, error: errorMeta(err) });
      return;
    }
    // info nahi, debug — har connected client se ~8s mein heartbeat aata hai, info level mein log bhar jaayega
    logger.debug("presence update", { docId, replicaId: senderReplicaId });

    room.broadcast({ type: "presence-update", docId, ...entry }, senderReplicaId);

    const payload: PresenceFanoutPayload = { originId: this.processId, kind: "update", entry };
    try {
      await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
    } catch (err) {
      logger.error("pubSubBus.publish (presence) failed", { docId, replicaId: senderReplicaId, error: errorMeta(err) });
    }
  }

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
      // yeh apna hi published message hai — already apply aur broadcast kar chuke hain, dobara mat karo
      if (payload.originId === this.processId) return;

      const entry = this.rooms.get(docId);
      // is process pe koi local room nahi hai matlab koi local socket bhi nahi — kisko notify karein
      if (!entry) return;
      entry.room.applyOps(payload.ops, payload.seq);
      entry.room.broadcast({ type: "broadcast-op", docId, seq: payload.seq, ops: payload.ops });
      logger.info("remote operation delivered", {
        docId,
        seq: payload.seq,
        ...summarizeOpIds(payload.ops.map(opIdKeyOf)),
        originId: payload.originId,
      });

      // fan-out se aaya hua op bhi hum best-effort persist karne ki koshish karte hain —
      // originating process ne already save kiya hoga, (docId, opId) unique constraint hai
      // isliye dobara insert karna safe hai, duplicate save nahi hoga
      try {
        await this.persistenceStore.appendOps(docId, payload.seq, payload.ops);
      } catch (err) {
        // fail ho bhi jaaye toh chalega — originating process pehle hi durability ka zimmedar hai
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
      // yahan bhi apna hi echo skip karna hai, presence wale flow mein bhi same rule
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
      // heartbeat TTL expire ho gaya matlab client bina clean leave bheje disconnect ho gaya —
      // in replicaIds ko bhi presence-leave bhej ke saaf kar do
      const expired = await this.presenceStore.sweep(docId);
      for (const replicaId of expired) {
        entry.room.broadcast({ type: "presence-leave", docId, replicaId });
        const payload: PresenceFanoutPayload = { originId: this.processId, kind: "leave", replicaId };
        await this.pubSubBus.publish(presenceChannel(docId), JSON.stringify(payload));
      }

      // threshold cross ho gaya toh snapshot le lo, warna Operation table hamesha badhta rahega
      if (entry.room.getOpsSinceSnapshot() >= this.snapshotOpThreshold) {
        await this.snapshotRoom(docId);
      }

      if (entry.room.isEmpty()) {
        entry.emptySince ??= Date.now();
        // idle timeout paar ho gaya toh room ka in-memory state hata do — koi client aayega toh
        // getOrCreateRoom phir se Postgres se load kar lega, data loss nahi hai
        if (Date.now() - entry.emptySince >= this.idleTimeoutMs) {
          clearInterval(entry.sweepTimer);
          await this.pubSubBus.unsubscribe(docChannel(docId));
          await this.pubSubBus.unsubscribe(presenceChannel(docId));
          this.rooms.delete(docId);
          logger.info("room evicted (idle timeout)", { docId, roomCount: this.rooms.size });
        }
      } else {
        entry.emptySince = null;
      }
    } catch (err) {
      // yeh setInterval ke andar chalta hai, koi await nahi kar raha — isliye yahan se
      // error throw hua toh sidha process crash, isliye try/catch mandatory hai
      logger.error("tick failed", { docId, error: errorMeta(err) });
    }
  }
}
