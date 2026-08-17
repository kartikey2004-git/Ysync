import { Rga, opIdKeyOf, opIdToString, type DeltaOp, type Op } from "@ysync/crdt";
import { parseServerMessage, type ClientMessage } from "@ysync/protocol";
import type { Edit as LocalEdit } from "./deltaToEdits";
import {
  addToOutbox,
  getOrCreateReplica,
  listOutbox,
  loadDocumentRecord,
  removeFromOutbox,
  saveDocumentRecord,
  type OutboxRecord,
} from "./db";

export interface RemotePresence {
  replicaId: string;
  cursor?: number | null;
  selection?: { anchor: number; head: number } | null;
  name?: string;
  color?: string;
}

export type ConnectionState = "connecting" | "open" | "closed";

export interface DocumentClientSnapshot {
  connectionState: ConnectionState;
  text: string;
  presence: RemotePresence[];
  replicaId: string;
  name: string;
  color: string;
  lastError: string | null;
  simulatedOffline: boolean;
}

const HEARTBEAT_INTERVAL_MS = 8_000;
const MAX_RECONNECT_DELAY_MS = 10_000;

const EMPTY_SNAPSHOT: DocumentClientSnapshot = {
  connectionState: "connecting",
  text: "",
  presence: [],
  replicaId: "",
  name: "",
  color: "",
  lastError: null,
  simulatedOffline: false,
};

// Local Rga, WS connection (join/op/presence/leave, backoff wala reconnect,
// presence heartbeat), aur ek document ke liye IndexedDB persistence — sab
// yahi class handle karti hai. Framework-agnostic hai — useDocument isko
// React ke liye subscribe/getSnapshot se wrap karta hai.
//
// Reconnect model: join mein sinceSeq bhejte hain, server ya toh incremental
// sync (sirf missing ops) ya poora snapshot fallback bhejta hai. Dono case
// mein client apna local state reconcile karta hai aur jo outbox ops abhi
// tak ack nahi hue unhe fresh op message se dobara bhej deta hai — chahe
// yeh pehla connection ho ya real/simulated drop ke baad ka reconnect.
export class DocumentClient {
  readonly docId: string;
  private readonly wsUrl: string;
  private rga: Rga;
  private replicaId = "";
  private name = "";
  private color = "";
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = "connecting";
  private lastAckedSeq = 0;
  private readonly outbox = new Map<string, OutboxRecord>();
  private readonly presence = new Map<string, RemotePresence>();
  private lastError: string | null = null;
  private readonly listeners = new Set<() => void>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastCursor: number | null = null;
  private lastSelection: { anchor: number; head: number } | null = null;
  private closedByUser = false;
  private simulatedOffline = false;
  private cachedSnapshot: DocumentClientSnapshot = EMPTY_SNAPSHOT;

  constructor(docId: string, wsUrl: string) {
    this.docId = docId;
    this.wsUrl = wsUrl;
    this.rga = new Rga(); // yeh temporary hai, init() resolve hone pe real replicaId wala Rga aa jayega
    void this.init();
  }

  private async init(): Promise<void> {
    const [replica, documentRecord, outboxRecords] = await Promise.all([
      getOrCreateReplica(this.docId),
      loadDocumentRecord(this.docId),
      listOutbox(this.docId),
    ]);

    this.replicaId = replica.replicaId;
    this.name = replica.name;
    this.color = replica.color;
    this.rga = documentRecord && documentRecord.snapshotState.length > 0
      ? Rga.fromSnapshot(documentRecord.snapshotState, this.replicaId)
      : new Rga(this.replicaId);
    this.lastAckedSeq = documentRecord?.lastAckedSeq ?? 0;

    // pehle se pending outbox ops ko local Rga mein wapas apply karo — offline
    // edits ka reflect hona connect hone se pehle hi zaroori hai
    for (const record of outboxRecords) {
      this.outbox.set(record.opId, record);
      this.rga.apply(record.op);
    }

    this.notify();
    this.connect();
  }

  private connect(): void {
    // user ne khud dispose kiya ho ya offline simulate kar rahe hon toh naya connection mat kholo
    if (this.closedByUser || this.simulatedOffline) return;
    this.connectionState = "connecting";
    this.notify();

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      // connect ho gaya, backoff counter reset kar do — agli baar disconnect hua toh phir 500ms se shuru hoga
      this.reconnectAttempt = 0;
      this.connectionState = "open";
      this.send({ type: "join", docId: this.docId, replicaId: this.replicaId, sinceSeq: this.lastAckedSeq });
      this.startHeartbeat();
      this.notify();
    });

    ws.addEventListener("message", (event) => {
      this.handleServerMessage(String(event.data));
    });

    ws.addEventListener("close", () => {
      this.connectionState = "closed";
      this.stopHeartbeat();
      this.notify();
      // agar user ne khud close kiya ya offline mode on hai toh reconnect mat karo,
      // warna network drop wagera ke baad khud retry karega
      if (!this.closedByUser && !this.simulatedOffline) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    // pehle se ek reconnect timer chal raha hai toh dobara schedule mat karo
    if (this.reconnectTimer) return;
    // exponential backoff: 500ms, 1s, 2s... MAX_RECONNECT_DELAY_MS tak cap
    const delay = Math.min(500 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendPresence(), HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleServerMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    const parsed = parseServerMessage(json);
    if (!parsed.success) return;
    const message = parsed.data;

    switch (message.type) {
      case "snapshot": {
        // poora scratch se rebuild karo — apne outbox ops server ke state mein
        // nahi hain (isiliye toh woh abhi bhi outbox mein pade hain), isliye
        // flush karne se pehle unhe upar se dobara integrate karo
        this.rga = message.state.length > 0 ? Rga.fromSnapshot(message.state, this.replicaId) : new Rga(this.replicaId);
        for (const record of this.outbox.values()) {
          this.rga.apply(record.op);
        }
        this.lastAckedSeq = message.seq;
        void this.persistDocumentState();
        this.flushOutbox();
        this.notify();
        break;
      }
      case "sync": {
        // incremental catch-up — apne outbox ops already local rga mein hain
        // (create hote hi optimistically apply ho chuke thay), bas jo miss
        // hua woh integrate karo, aur outbox flush kar do — ho sakta hai
        // server ne pehle wala op receive hi na kiya ho (ack se pehle drop ho gaya)
        this.rga.applyAll(message.ops);
        this.lastAckedSeq = message.seq;
        void this.persistDocumentState();
        this.flushOutbox();
        this.notify();
        break;
      }
      case "broadcast-op": {
        this.rga.applyAll(message.ops);
        this.notify();
        break;
      }
      case "ack": {
        // server ne durably save kar liya, ab outbox mein rakhne ki zaroorat nahi
        for (const opId of message.opIds) {
          const key = opIdToString(opId);
          this.outbox.delete(key);
          void removeFromOutbox(this.docId, key);
        }
        this.lastAckedSeq = message.seq;
        void this.persistDocumentState();
        this.notify();
        break;
      }
      case "presence-update": {
        this.presence.set(message.replicaId, {
          replicaId: message.replicaId,
          cursor: message.cursor,
          selection: message.selection,
          name: message.name,
          color: message.color,
        });
        this.notify();
        break;
      }
      case "presence-leave": {
        this.presence.delete(message.replicaId);
        this.notify();
        break;
      }
      case "error": {
        this.lastError = message.message;
        this.notify();
        break;
      }
    }
  }

  private async persistDocumentState(): Promise<void> {
    await saveDocumentRecord({
      docId: this.docId,
      lastAckedSeq: this.lastAckedSeq,
      snapshotState: this.rga.toSnapshot(),
    });
  }

  // Quill-Delta-shaped current content hai — editor binding ke liye, React snapshot ke liye nahi (har notify pe recompute nahi karna padta)
  getContentsForEditor(): DeltaOp[] {
    return this.rga.getContentsForEditor();
  }

  // Ek poore batch ke local edits (ek Quill delta jitne) Rga pe apply karta hai
  // aur subscribers ko sirf ek baar notify karta hai, sab land hone ke baad.
  // Editor.tsx ko per-edit local mutation call nahi karna chahiye — Quill
  // apna poora delta apne document pe already apply kar chuka hota hai
  // text-change fire hone tak, isliye beech mein notify karne se Editor ka
  // subscribe-diff-sync (quill.updateContents) half-applied Rga ke against
  // chal jayega aur Quill ke indices CRDT se desync ho jayenge.
  applyLocalEdits(edits: LocalEdit[]): void {
    if (edits.length === 0) return;
    const ops: Op[] = [];
    for (const edit of edits) {
      const op = edit.kind === "insert"
        ? this.rga.localInsert(edit.index, edit.value)
        : this.rga.localDelete(edit.index);
      ops.push(op);
    }
    for (const op of ops) {
      const opId = opIdKeyOf(op);
      const record: OutboxRecord = { docId: this.docId, opId, op, createdAt: Date.now() };
      this.outbox.set(opId, record);
      void addToOutbox(record);
    }
    this.send({ type: "op", docId: this.docId, ops });
    this.notify();
  }

  // jitne bhi local ops abhi ack nahi hue, sabko ek op message mein dobara bhej deta hai —
  // dobara call karna bhi safe hai, server side opId pe idempotent hai
  private flushOutbox(): void {
    if (this.outbox.size === 0) return;
    const ops = [...this.outbox.values()].map((record) => record.op);
    this.send({ type: "op", docId: this.docId, ops });
  }

  // Manual offline simulation hai — live connection band kar deta hai aur jab
  // tak true hai reconnect skip karta hai, local edits waise hi apply aur
  // outbox mein queue hote rehte hain jaise real network drop mein hota. false
  // karne pe wahi join -> catch-up -> outbox-flush path chalta hai jo real
  // reconnect mein chalta hai.
  setSimulatedOffline(offline: boolean): void {
    if (this.simulatedOffline === offline) return;
    this.simulatedOffline = offline;

    if (offline) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.stopHeartbeat();
      this.ws?.close();
      this.ws = null;
      this.connectionState = "closed";
      this.notify();
    } else {
      this.reconnectAttempt = 0;
      this.connect();
    }
  }

  updatePresence(cursor: number | null, selection: { anchor: number; head: number } | null): void {
    this.lastCursor = cursor;
    this.lastSelection = selection;
    this.sendPresence();
  }

  private sendPresence(): void {
    if (!this.replicaId) return;
    this.send({
      type: "presence",
      docId: this.docId,
      cursor: this.lastCursor,
      selection: this.lastSelection,
      name: this.name,
      color: this.color,
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): DocumentClientSnapshot {
    return this.cachedSnapshot;
  }

  private computeSnapshot(): DocumentClientSnapshot {
    return {
      connectionState: this.connectionState,
      text: this.rga.read(),
      presence: [...this.presence.values()],
      replicaId: this.replicaId,
      name: this.name,
      color: this.color,
      simulatedOffline: this.simulatedOffline,
      lastError: this.lastError,
    };
  }

  private notify(): void {
    this.cachedSnapshot = this.computeSnapshot();
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.ws?.close();
  }
}

export { EMPTY_SNAPSHOT };
