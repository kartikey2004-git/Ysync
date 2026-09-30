import http from "node:http";
import { randomUUID } from "node:crypto";
import express from "express";
import cors from "cors";
import { WebSocketServer, type WebSocket } from "ws";
import { toNodeHandler } from "better-auth/node";
import { parseClientMessage, type ErrorMessage, type ServerMessage } from "@ysync/protocol";
import { RoomManager, type RoomManagerOptions } from "./roomManager.js";
import { logger, errorMeta } from "./logger.js";
import type { Auth } from "./auth/betterAuth.js";
import type { AuthorizationService } from "./auth/authorizationService.js";
import { authenticateWsUpgrade } from "./auth/wsAuth.js";
import { createDocumentRouter } from "./routes/documents.js";
import type { PrismaClient } from "@ysync/database";
import { register, activeWsConnections } from "./metrics.js";

export interface CreateServerOptions extends RoomManagerOptions {
  allowedOrigins?: string[];
  auth?: Auth;
  authorizationService?: AuthorizationService;
  prisma?: PrismaClient;
  healthCheck?: () => Promise<{ postgres: boolean; redis: boolean }>;
}

const MAX_WS_PAYLOAD_BYTES = 1_048_576;

export interface YSyncServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  roomManager: RoomManager;
}

interface SocketState {
  docId: string;
  replicaId: string;
  userId: string;
  sessionId: string;
  canWrite: boolean;
}

function sendError(socket: WebSocket, code: string, message: string): void {
  const payload: ErrorMessage = { type: "error", code, message };
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

export function createServer(options: CreateServerOptions): YSyncServer {
  const { auth, authorizationService, prisma, allowedOrigins, healthCheck, ...roomManagerOpts } = options;
  const roomManager = new RoomManager(roomManagerOpts);
  const app = express();

  // CORS — must come before routes, credentials required for session cookies
  const corsOrigins = allowedOrigins?.length ? allowedOrigins : undefined;
  app.use(cors({
    origin: corsOrigins ?? true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  }));

  // Better Auth handler — must come BEFORE express.json() per Better Auth docs
  if (auth) {
    app.all("/api/auth/*", toNodeHandler(auth));
  }

  app.get("/health", async (_req, res) => {
    if (healthCheck) {
      try {
        const checks = await healthCheck();
        const ok = checks.postgres && checks.redis;
        res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "error", checks });
      } catch {
        res.status(503).json({ status: "error", checks: { postgres: false, redis: false } });
      }
    } else {
      res.status(200).json({ status: "ok" });
    }
  });

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  });

  // Document CRUD + member management
  if (prisma && authorizationService && auth) {
    app.use("/api/documents", createDocumentRouter(prisma, authorizationService, auth));
  }

  const httpServer = http.createServer(app);

  const socketState = new WeakMap<WebSocket, SocketState>();

  // When auth is configured, use noServer mode for authenticated WS upgrades.
  // Without auth (legacy/test mode), attach directly to httpServer.
  const wss = auth
    ? new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES })
    : new WebSocketServer({
        server: httpServer,
        maxPayload: MAX_WS_PAYLOAD_BYTES,
        verifyClient: allowedOrigins?.length
          ? (info, callback) => {
              if (info.origin && allowedOrigins.includes(info.origin)) { callback(true); return; }
              logger.warn("rejected ws connection: origin not allowed", { origin: info.origin || "(missing)" });
              callback(false, 403, "origin not allowed");
            }
          : undefined,
      });

  if (auth) {
    httpServer.on("upgrade", async (req, socket, head) => {
      if (allowedOrigins?.length) {
        const origin = req.headers.origin;
        if (!origin || !allowedOrigins.includes(origin)) {
          logger.warn("rejected ws upgrade: origin not allowed", { origin: origin || "(missing)" });
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      const authResult = await authenticateWsUpgrade(auth, req);
      if (!authResult) {
        logger.warn("rejected ws upgrade: no valid session");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as WebSocket & { __authUserId: string; __authSessionId: string }).__authUserId = authResult.userId;
        (ws as WebSocket & { __authSessionId: string }).__authSessionId = authResult.sessionId;
        wss.emit("connection", ws, req);
      });
    });
  }

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
      if (state) {
        sendError(socket, "ALREADY_JOINED", "this connection already joined a document");
        return;
      }

      const authSocket = socket as WebSocket & { __authUserId?: string; __authSessionId?: string };
      const userId = authSocket.__authUserId ?? "";
      const sessionId = authSocket.__authSessionId ?? "";

      // When auth is configured, enforce document-level authorization
      if (authorizationService && userId) {
        const canRead = await authorizationService.canReadDocument(userId, message.docId);
        if (!canRead) {
          logger.warn("ws join denied: no access", { connectionId, userId, docId: message.docId });
          sendError(socket, "FORBIDDEN", "you do not have access to this document");
          socket.close(4003, "forbidden");
          return;
        }
      }

      const canWrite = authorizationService && userId
        ? await authorizationService.canWriteDocument(userId, message.docId)
        : true;

      // Server-derived replicaId when auth is active
      let replicaId: string;
      if (userId) {
        const clientReplicaId = message.replicaId;
        const expectedPrefix = `${userId}:`;
        replicaId = clientReplicaId.startsWith(expectedPrefix)
          ? clientReplicaId
          : `${userId}:${clientReplicaId}`;
      } else {
        replicaId = message.replicaId;
      }

      logger.info("join received", {
        connectionId,
        docId: message.docId,
        userId: userId || "(unauthenticated)",
        replicaId,
        sinceSeq: message.sinceSeq,
        canWrite,
      });

      const catchUp = await roomManager.join(message.docId, replicaId, socket, message.sinceSeq, connectionId);
      socketState.set(socket, { docId: message.docId, replicaId, userId, sessionId, canWrite });

      const reply: ServerMessage =
        catchUp.kind === "sync"
          ? { type: "sync", docId: message.docId, seq: catchUp.seq, ops: catchUp.ops }
          : { type: "snapshot", docId: message.docId, seq: catchUp.seq, state: catchUp.state };
      socket.send(JSON.stringify(reply));

      logger.info("join completed", {
        connectionId,
        docId: message.docId,
        replicaId,
        kind: catchUp.kind,
        seq: catchUp.seq,
      });
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
      // Authorize: only OWNER and EDITOR can write
      if (!state.canWrite) {
        logger.warn("op rejected: viewer cannot write", {
          connectionId,
          docId: state.docId,
          userId: state.userId,
        });
        sendError(socket, "FORBIDDEN", "you do not have write access to this document");
        return;
      }
      logger.info("operation received", {
        connectionId,
        docId: state.docId,
        replicaId: state.replicaId,
        userId: state.userId,
        opCount: message.ops.length,
      });
      await roomManager.applyClientOp(state.docId, state.replicaId, message.ops, connectionId);
      return;
    }
    if (message.type === "presence") {
      // Presence uses server-derived identity, not client-supplied name
      await roomManager.updatePresence(state.docId, state.replicaId, {
        cursor: message.cursor,
        selection: message.selection,
        name: message.name,
        color: message.color,
      }, connectionId);
      return;
    }
    if (message.type === "leave") {
      logger.info("leave received", { connectionId, docId: state.docId, replicaId: state.replicaId, userId: state.userId });
      await roomManager.leave(state.docId, state.replicaId, socket, connectionId);
      socketState.delete(socket);
    }
  }

  async function handleMessage(connectionId: string, socket: WebSocket, raw: string): Promise<void> {
    try {
      await dispatchMessage(connectionId, socket, raw);
    } catch (err) {
      logger.error("unhandled error dispatching message", { connectionId, error: errorMeta(err) });
      try {
        sendError(socket, "INTERNAL_ERROR", "the server hit an unexpected error handling your message");
      } catch (sendErr) {
        logger.error("failed to send INTERNAL_ERROR to socket", { connectionId, error: errorMeta(sendErr) });
      }
    }
  }

  wss.on("connection", (socket) => {
    const connectionId = randomUUID();
    const authSocket = socket as WebSocket & { __authUserId?: string };
    logger.info("ws connection accepted", { connectionId, userId: authSocket.__authUserId });
    activeWsConnections.inc();

    socket.on("message", (raw) => {
      void handleMessage(connectionId, socket, raw.toString());
    });
    socket.on("close", () => {
      activeWsConnections.dec();
      const state = socketState.get(socket);
      logger.info("ws connection closed", { connectionId, docId: state?.docId, replicaId: state?.replicaId, userId: state?.userId });
      if (state) {
        roomManager.leave(state.docId, state.replicaId, socket, connectionId).catch((err: unknown) => {
          logger.error("roomManager.leave failed on close", {
            connectionId,
            docId: state.docId,
            replicaId: state.replicaId,
            error: errorMeta(err),
          });
        });
      }
    });
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
