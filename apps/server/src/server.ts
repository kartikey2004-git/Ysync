import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ErrorMessage, type ServerMessage } from "@ysync/protocol";
import { RoomManager, type RoomManagerOptions } from "./roomManager.js";
import { logger, errorMeta } from "./logger.js";

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

// Yahan WS upgrade aur per-socket message dispatch wire hota hai. Stores
// RoomManagerOptions se aate hain isliye tests real Redis/Postgres ki jagah
// in-memory fakes daal sakte hain, is file ko touch kiye bina.
export function createServer(options: CreateServerOptions): YSyncServer {
  const roomManager = new RoomManager(options);
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  const socketState = new WeakMap<WebSocket, SocketState>();

  async function dispatchMessage(connectionId: string, socket: WebSocket, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      logger.warn("invalid ws message", { connectionId, code: "INVALID_JSON" });
      sendError(socket, "INVALID_JSON", "message was not valid JSON");
      return;
    }

    const parsed = parseClientMessage(json);
    if (!parsed.success) {
      logger.warn("invalid ws message", { connectionId, code: "INVALID_MESSAGE", reason: parsed.error });
      sendError(socket, "INVALID_MESSAGE", parsed.error);
      return;
    }

    const message = parsed.data;
    const state = socketState.get(socket);

    if (message.type === "join") {
      // ek socket sirf ek baar join kar sakta hai — dusri baar join aaya matlab client ne galti se resend kiya
      if (state) {
        sendError(socket, "ALREADY_JOINED", "this connection already joined a document");
        return;
      }
      logger.info("join received", {
        connectionId,
        docId: message.docId,
        replicaId: message.replicaId,
        sinceSeq: message.sinceSeq,
      });
      const catchUp = await roomManager.join(message.docId, message.replicaId, socket, message.sinceSeq);
      socketState.set(socket, { docId: message.docId, replicaId: message.replicaId });
      const reply: ServerMessage =
        catchUp.kind === "sync"
          ? { type: "sync", docId: message.docId, seq: catchUp.seq, ops: catchUp.ops }
          : { type: "snapshot", docId: message.docId, seq: catchUp.seq, state: catchUp.state };
      socket.send(JSON.stringify(reply));
      logger.info("join completed", {
        connectionId,
        docId: message.docId,
        replicaId: message.replicaId,
        kind: catchUp.kind,
        seq: catchUp.seq,
      });
      return;
    }

    // join se pehle kuch bhi bhejo toh reject — server ko pata hi nahi kaunsa doc/replica hai
    if (!state) {
      sendError(socket, "NOT_JOINED", "send a join message before anything else");
      return;
    }
    // ek connection ek hi doc ke liye — dusre docId ka op/presence aaya toh galat client state hai
    if (message.docId !== state.docId) {
      sendError(socket, "WRONG_DOC", "this connection is joined to a different document");
      return;
    }

    if (message.type === "op") {
      logger.info("operation received", {
        connectionId,
        docId: state.docId,
        replicaId: state.replicaId,
        opCount: message.ops.length,
      });
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
      logger.info("leave received", { connectionId, docId: state.docId, replicaId: state.replicaId });
      await roomManager.leave(state.docId, state.replicaId);
      socketState.delete(socket);
    }
  }

  // dispatchMessage ka error yahin pe pakadna zaroori hai — Node 15+ mein unhandled
  // rejection se pura process crash ho jata hai, aur is instance ke saare clients
  // disconnect ho jayenge, sirf jisne error diya wahi nahi.
  async function handleMessage(connectionId: string, socket: WebSocket, raw: string): Promise<void> {
    try {
      await dispatchMessage(connectionId, socket, raw);
    } catch (err) {
      logger.error("unhandled error dispatching message", { connectionId, error: errorMeta(err) });
      try {
        sendError(socket, "INTERNAL_ERROR", "the server hit an unexpected error handling your message");
      } catch (sendErr) {
        // socket pehle hi band ho chuka ho sakta hai, isliye yeh bhi fail ho sakta hai — bas log kar do
        logger.error("failed to send INTERNAL_ERROR to socket", { connectionId, error: errorMeta(sendErr) });
      }
    }
  }

  wss.on("connection", (socket) => {
    const connectionId = randomUUID();
    logger.info("ws connection accepted", { connectionId });

    socket.on("message", (raw) => {
      void handleMessage(connectionId, socket, raw.toString());
    });
    socket.on("close", () => {
      const state = socketState.get(socket);
      logger.info("ws connection closed", { connectionId, docId: state?.docId, replicaId: state?.replicaId });
      if (state) {
        // yeh .catch zaroori hai — close event ke andar promise reject hone do toh unhandled rejection ban jayega
        roomManager.leave(state.docId, state.replicaId).catch((err: unknown) => {
          logger.error("roomManager.leave failed on close", {
            connectionId,
            docId: state.docId,
            replicaId: state.replicaId,
            error: errorMeta(err),
          });
        });
      }
    });
    // yeh listener na ho toh koi bhi random connection reset (proxy hiccup,
    // client ka network switch, kuch bhi) unhandled throw karke pura process gira dega
    socket.on("error", (err) => {
      const state = socketState.get(socket);
      logger.warn("ws connection error", {
        connectionId,
        docId: state?.docId,
        replicaId: state?.replicaId,
        error: errorMeta(err),
      });
    });
  });

  wss.on("error", (err) => {
    logger.error("WebSocketServer error", { error: errorMeta(err) });
  });

  return { httpServer, wss, roomManager };
}
