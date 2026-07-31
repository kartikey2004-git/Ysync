import http from "node:http";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ErrorMessage, type ServerMessage } from "@ysync/protocol";
import { RoomManager, type RoomManagerOptions } from "./roomManager.js";

export type CreateServerOptions = RoomManagerOptions;

export interface YSyncServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  roomManager: RoomManager;
}

interface SocketState {
  docId: string;
  replicaId: string;
}

function sendError(socket: WebSocket, code: string, message: string): void {
  const payload: ErrorMessage = { type: "error", code, message };
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

/**
 * Wires the WS upgrade + per-socket message dispatch described in
 * system-design.md §6. Dependency-injected (`RoomManagerOptions`) so tests
 * can run against in-memory fakes or real Redis without touching this file
 * — see docs/changes/phase-3-server-core.md.
 */
export function createServer(options: CreateServerOptions): YSyncServer {
  const roomManager = new RoomManager(options);
  const app = express();
  app.get("/healthz", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const socketState = new WeakMap<WebSocket, SocketState>();

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      sendError(socket, "INVALID_JSON", "message was not valid JSON");
      return;
    }

    const parsed = parseClientMessage(json);
    if (!parsed.success) {
      sendError(socket, "INVALID_MESSAGE", parsed.error);
      return;
    }

    const message = parsed.data;
    const state = socketState.get(socket);

    if (message.type === "join") {
      if (state) {
        sendError(socket, "ALREADY_JOINED", "this connection already joined a document");
        return;
      }
      const room = await roomManager.join(message.docId, message.replicaId, socket);
      socketState.set(socket, { docId: message.docId, replicaId: message.replicaId });
      const snapshot: ServerMessage = {
        type: "snapshot",
        docId: message.docId,
        seq: room.currentSeq(),
        state: room.snapshot(),
      };
      socket.send(JSON.stringify(snapshot));
      return;
    }

    if (!state) {
      sendError(socket, "NOT_JOINED", "send a join message before anything else");
      return;
    }
    if (message.docId !== state.docId) {
      sendError(socket, "WRONG_DOC", "this connection is joined to a different document");
      return;
    }

    if (message.type === "op") {
      await roomManager.applyClientOp(state.docId, state.replicaId, message.ops);
      return;
    }
    if (message.type === "presence") {
      await roomManager.updatePresence(state.docId, state.replicaId, {
        cursor: message.cursor,
        selection: message.selection,
        name: message.name,
        color: message.color,
      });
      return;
    }
    if (message.type === "leave") {
      await roomManager.leave(state.docId, state.replicaId);
      socketState.delete(socket);
    }
  }

  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      void handleMessage(socket, raw.toString());
    });
    socket.on("close", () => {
      const state = socketState.get(socket);
      if (state) void roomManager.leave(state.docId, state.replicaId);
    });
  });

  return { httpServer, wss, roomManager };
}
