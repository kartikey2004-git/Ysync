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

/**
 * Owns the local Rga, the WS connection (join/op/presence/leave, reconnect
 * with backoff, presence heartbeat), and IndexedDB persistence for one
 * document (system-design.md §8.1). Framework-agnostic — `useDocument`
 * wraps it for React via `subscribe`/`getSnapshot`.
 *
 * Reconnect model (system-design.md §8.3): `join` carries `sinceSeq`, and
 * the server replies with either an incremental `sync` (just the missing
 * ops) or a full `snapshot` fallback. Either way, this client reconciles
 * its local state and then flushes any not-yet-acked outbox ops as a
 * fresh `op` message — correct whether this is the first connection or a
 * reconnect after a drop, real or simulated (`setSimulatedOffline`).
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
  private simulatedOffline = false;
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
    if (this.closedByUser || this.simulatedOffline) return;
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
      if (!this.closedByUser && !this.simulatedOffline) this.scheduleReconnect();
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
        // rebuild from scratch — our own outbox ops aren't in the server's
        // state (that's why they're still outbox entries), so reintegrate
        // them on top before flushing.
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
        // incremental catch-up — our own outbox ops are already part of
        // the local rga (applied optimistically when created), so just
        // integrate what we were missing and flush the outbox in case the
        // server never actually received it (e.g. dropped before an ack).
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

  /**
   * Applies a whole batch of local edits (one Quill delta's worth) to the
   * Rga and notifies subscribers exactly once, after all of them have
   * landed. Editor.tsx must not call the local mutation directly per edit —
   * Quill has already applied the *entire* delta to its own document by the
   * time text-change fires, so notifying mid-batch lets Editor's
   * subscribe-diff-sync (quill.updateContents) run against a half-applied
   * Rga and desyncs Quill's indices from the CRDT (see docs/changes/
   * fix-reentrant-notify-editor-desync.md).
   */
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

  /** Re-sends every not-yet-acked local op as one `op` message — safe to call redundantly (server-side idempotent on opId). */
  private flushOutbox(): void {
    if (this.outbox.size === 0) return;
    const ops = [...this.outbox.values()].map((record) => record.op);
    this.send({ type: "op", docId: this.docId, ops });
  }

  /**
   * Manual offline simulation (plan.md Phase 6): closes the live
   * connection and skips reconnect while `true` — local edits keep
   * applying and queuing in the outbox exactly as during a real network
   * drop. Reconnecting on `false` drives the same join -> catch-up ->
   * outbox-flush path a real reconnect does.
   */
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
