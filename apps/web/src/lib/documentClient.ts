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

// This class handles everything for one document: the local Rga, the WS connection
// (join/op/presence/leave, backoff reconnect, presence heartbeat), and IndexedDB
// persistence. It's framework-agnostic — useDocument wraps it in subscribe/getSnapshot for React.
//
// Reconnect model: join sends sinceSeq, and the server replies with either an
// incremental sync (just the missing ops) or a full snapshot as a fallback. Either way
// the client reconciles its local state and resends any outbox ops that haven't been
// acked yet in a fresh op message — whether this is the first connection or a reconnect
// after a real/simulated drop.
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
    this.rga = new Rga(); // temporary — replaced with the real replicaId's Rga once init() resolves
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

    // reapply any pending outbox ops to the local Rga — offline edits need to show up
    // before we even connect
    for (const record of outboxRecords) {
      this.outbox.set(record.opId, record);
      this.rga.apply(record.op);
    }

    this.notify();
    this.connect();
  }

  private connect(): void {
    // don't open a new connection if the user disposed this or offline mode is simulated
    if (this.closedByUser || this.simulatedOffline) return;
    this.connectionState = "connecting";
    this.notify();

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      // connected — reset the backoff counter, so the next disconnect starts again from 500ms
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
      // don't reconnect if the user closed this themselves or offline mode is on,
      // otherwise retry automatically after a network drop or similar
      if (!this.closedByUser && !this.simulatedOffline) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    // a reconnect timer is already running, don't schedule another one
    if (this.reconnectTimer) return;
    // exponential backoff: 500ms, 1s, 2s... capped at MAX_RECONNECT_DELAY_MS
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
        // rebuild from scratch — our own outbox ops aren't in the server's state (that's
        // exactly why they're still sitting in the outbox), so reintegrate them on top before flushing
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
        // incremental catch-up — our own outbox ops are already in the local rga (they
        // were applied optimistically when created), just integrate whatever was missed,
        // and flush the outbox — the server may not have received an earlier op (dropped before the ack)
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
        // the server durably saved it, no need to keep it in the outbox anymore
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

  // Current content shaped as a Quill Delta — for the editor binding, not the React
  // snapshot, so it isn't recomputed on every notify.
  getContentsForEditor(): DeltaOp[] {
    return this.rga.getContentsForEditor();
  }

  // Applies a whole batch of local edits (as many as one Quill delta) to the Rga and
  // notifies subscribers only once, after everything has landed. Editor.tsx should
  // never call this per-edit for a local mutation — Quill has already applied its whole
  // delta to its own document by the time text-change fires, so notifying in between
  // would run Editor's subscribe-diff-sync (quill.updateContents) against a
  // half-applied Rga and desync Quill's indices from the CRDT.
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

  // Resends every local op that hasn't been acked yet in one op message — safe to call
  // repeatedly too, the server side is idempotent on opId.
  private flushOutbox(): void {
    if (this.outbox.size === 0) return;
    const ops = [...this.outbox.values()].map((record) => record.op);
    this.send({ type: "op", docId: this.docId, ops });
  }

  // Manual offline simulation — closes the live connection and skips reconnecting while
  // true, while local edits still apply and queue in the outbox exactly like they would
  // during a real network drop. Setting it back to false runs the same
  // join -> catch-up -> outbox-flush path a real reconnect goes through.
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
