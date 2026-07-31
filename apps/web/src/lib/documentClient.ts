import { Rga, opIdKeyOf, opIdToString, type DeltaOp, type Op } from "@ysync/crdt";
import { parseServerMessage, type ClientMessage } from "@ysync/protocol";
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
};

/**
 * Owns the local Rga, the WS connection (join/op/presence/leave, reconnect
 * with backoff, presence heartbeat), and IndexedDB persistence for one
 * document (system-design.md §8.1). Framework-agnostic — `useDocument`
 * wraps it for React via `subscribe`/`getSnapshot`.
 *
 * Reconnect model (see docs/changes/phase-5-web-editor.md): the server
 * only ever replies to `join` with a full `snapshot`, so on every
 * connect/reconnect this rebuilds the Rga from that snapshot and reapplies
 * its own not-yet-acked outbox ops on top (Rga.apply is idempotent), then
 * re-sends the outbox — correct whether this is the first connection or a
 * reconnect after a drop.
 */
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
  private cachedSnapshot: DocumentClientSnapshot = EMPTY_SNAPSHOT;

  constructor(docId: string, wsUrl: string) {
    this.docId = docId;
    this.wsUrl = wsUrl;
    this.rga = new Rga(); // replaced with the real replicaId once init() resolves
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

    for (const record of outboxRecords) {
      this.outbox.set(record.opId, record);
      this.rga.apply(record.op);
    }

    this.notify();
    this.connect();
  }

  private connect(): void {
    if (this.closedByUser) return;
    this.connectionState = "connecting";
    this.notify();

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
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
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
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
        this.rga = message.state.length > 0 ? Rga.fromSnapshot(message.state, this.replicaId) : new Rga(this.replicaId);
        this.lastAckedSeq = message.seq;
        const pendingOps: Op[] = [];
        for (const record of this.outbox.values()) {
          this.rga.apply(record.op);
          pendingOps.push(record.op);
        }
        void this.persistDocumentState();
        if (pendingOps.length > 0) {
          this.send({ type: "op", docId: this.docId, ops: pendingOps });
        }
        this.notify();
        break;
      }
      case "sync": {
        this.rga.applyAll(message.ops);
        this.lastAckedSeq = message.seq;
        void this.persistDocumentState();
        this.notify();
        break;
      }
      case "broadcast-op": {
        this.rga.applyAll(message.ops);
        this.notify();
        break;
      }
      case "ack": {
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

  /** Quill-Delta-shaped current content — for the editor binding, not the React snapshot (avoids recomputing on every notify). */
  getContentsForEditor(): DeltaOp[] {
    return this.rga.getContentsForEditor();
  }

  insertText(index: number, value: string): void {
    this.recordLocalOp(this.rga.localInsert(index, value));
  }

  deleteText(index: number): void {
    this.recordLocalOp(this.rga.localDelete(index));
  }

  private recordLocalOp(op: Op): void {
    const opId = opIdKeyOf(op);
    const record: OutboxRecord = { docId: this.docId, opId, op, createdAt: Date.now() };
    this.outbox.set(opId, record);
    void addToOutbox(record);
    this.send({ type: "op", docId: this.docId, ops: [op] });
    this.notify();
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
