import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ErrorMessage, type ServerMessage } from "@ysync/protocol";
import { RoomManager, type RoomManagerOptions } from "./roomManager.js";
import { logger, errorMeta } from "./logger.js";

export interface CreateServerOptions extends RoomManagerOptions {
  // left unset/empty, origin checking stays disabled, no breaking change without an opt-in
  allowedOrigins?: string[];
}

const MAX_WS_PAYLOAD_BYTES = 1_048_576; // 1 MiB well above realistic edit batches, but still bounded

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

// Wires up the WS upgrade and per-socket message dispatch. Stores come in through RoomManagerOptions so tests can swap in in-memory fakes instead of real Redis/Postgres
export function createServer(options: CreateServerOptions): YSyncServer {
  const roomManager = new RoomManager(options);
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  const httpServer = http.createServer(app);
  const allowedOrigins = options.allowedOrigins;
  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    // allow every origin when allowedOrigins isn't configured, enforcement only kicks in when opted into
    verifyClient: allowedOrigins?.length
      ? (info, callback) => {
          if (info.origin && allowedOrigins.includes(info.origin)) {
            callback(true);
            return;
          }
          logger.warn("rejected ws connection: origin not allowed", { origin: info.origin || "(missing)" });
          callback(false, 403, "origin not allowed");
        }
      : undefined,
  });
  const socketState = new WeakMap<WebSocket, SocketState>();

  // single entry point for every inbound message on a socket, validates first, then routes by type, so nothing downstream ever sees untrusted/malformed input
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
      // a socket can only join once, a second join means the client resent by mistake
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

    // reject anything sent before join, the server doesn't know which doc/replica this is yet
    if (!state) {
      sendError(socket, "NOT_JOINED", "send a join message before anything else");
      return;
    }
    // one connection is scoped to one doc, an op/presence for a different docId means bad client state
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
      await roomManager.leave(state.docId, state.replicaId, socket);
      socketState.delete(socket);
    }
  }

  // errors from dispatchMessage must be caught right here, on Node 15+ an unhandled rejection crashes the whole process, disconnecting every client on this instance, not just the one that triggered the error
  async function handleMessage(connectionId: string, socket: WebSocket, raw: string): Promise<void> {
    try {
      await dispatchMessage(connectionId, socket, raw);
    } catch (err) {
      logger.error("unhandled error dispatching message", { connectionId, error: errorMeta(err) });
      try {
        sendError(socket, "INTERNAL_ERROR", "the server hit an unexpected error handling your message");
      } catch (sendErr) {
        // the socket may already be closed, so this can fail too, just log it
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
        // this is required letting a promise reject inside a close event handler becomes an unhandled rejection
        roomManager.leave(state.docId, state.replicaId, socket).catch((err: unknown) => {
          logger.error("roomManager.leave failed on close", {
            connectionId,
            docId: state.docId,
            replicaId: state.replicaId,
            error: errorMeta(err),
          });
        });
      }
    });
    // without this listener, any random connection reset (proxy hiccup, client network, anything) throws unhandled and takes down the whole process
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
