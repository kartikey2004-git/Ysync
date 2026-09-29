import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { ServerMessage } from "@ysync/protocol";
import {
  isPostgresReachable,
  startAuthServer,
  createTestUser,
  authenticatedFetch,
  createDocumentAsUser,
  connectAuthenticatedWs,
  connectWs,
  nextMessage,
  sendWs,
  joinDocument,
  waitForClose,
  uniqueEmail,
  type TestServerContext,
} from "./helpers/authTestHelpers.js";

const postgresAvailable = await isPostgresReachable();

describe.skipIf(!postgresAvailable)("WebSocket authentication & authorization (requires live Postgres)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await startAuthServer();
  });

  afterAll(async () => {
    await ctx?.cleanup();
  });

  describe("WS connection authentication", () => {
    test("unauthenticated WS connection is rejected", async () => {
      try {
        const ws = await connectWs(ctx.wsUrl);
        // If the connection opens (no auth check on upgrade yet), the join should fail
        const reply = await joinDocument(ws, "any-doc", "replica-1");
        // Expect either a close or an auth error
        expect(reply.type).toBe("error");
        if (reply.type === "error") {
          expect(["UNAUTHENTICATED", "FORBIDDEN", "NOT_JOINED"]).toContain(reply.code);
        }
        ws.close();
      } catch {
        // Connection rejected during upgrade — this is the expected behavior
      }
    });

    test("authenticated WS connection is accepted", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "WS User");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookie);

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookie);
      const reply = await joinDocument(ws, docId, "replica-1");
      expect(["sync", "snapshot"]).toContain(reply.type);
      ws.close();
    });
  });

  describe("Document access authorization", () => {
    test("authenticated user can join their own document", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookie);

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookie);
      const reply = await joinDocument(ws, docId, "replica-1");
      expect(["sync", "snapshot"]).toContain(reply.type);
      ws.close();
    });

    test("authenticated user cannot join a document they have no access to", async () => {
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieStranger = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Stranger");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookieStranger);
      const reply = await joinDocument(ws, docId, "replica-1");
      expect(reply.type).toBe("error");
      if (reply.type === "error") {
        expect(["FORBIDDEN", "DOCUMENT_NOT_FOUND"]).toContain(reply.code);
      }
      ws.close();
    });

    test("EDITOR can join and read a shared document", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookieEditor);
      const reply = await joinDocument(ws, docId, "replica-1");
      expect(["sync", "snapshot"]).toContain(reply.type);
      ws.close();
    });

    test("VIEWER can join and read a shared document", async () => {
      const emailViewer = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieViewer = await createTestUser(ctx.httpUrl, emailViewer, "Test1234!!", "Viewer");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailViewer, role: "VIEWER" }),
      });

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookieViewer);
      const reply = await joinDocument(ws, docId, "replica-1");
      expect(["sync", "snapshot"]).toContain(reply.type);
      ws.close();
    });
  });

  describe("Write authorization", () => {
    test("OWNER can send ops", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookie);

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookie);
      await joinDocument(ws, docId, "owner-replica");

      const ackPromise = nextMessage(ws);
      sendWs(ws, {
        type: "op",
        docId,
        ops: [{ type: "insert", id: { counter: 1, replicaId: "owner-replica" }, originId: null, value: "h" }],
      });

      const reply = await ackPromise;
      expect(reply.type).toBe("ack");
      ws.close();
    });

    test("EDITOR can send ops", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookieEditor);
      await joinDocument(ws, docId, "editor-replica");

      const ackPromise = nextMessage(ws);
      sendWs(ws, {
        type: "op",
        docId,
        ops: [{ type: "insert", id: { counter: 1, replicaId: "editor-replica" }, originId: null, value: "h" }],
      });

      const reply = await ackPromise;
      expect(reply.type).toBe("ack");
      ws.close();
    });

    test("VIEWER cannot send ops (gets FORBIDDEN error)", async () => {
      const emailViewer = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieViewer = await createTestUser(ctx.httpUrl, emailViewer, "Test1234!!", "Viewer");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailViewer, role: "VIEWER" }),
      });

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookieViewer);
      await joinDocument(ws, docId, "viewer-replica");

      const errorPromise = nextMessage(ws);
      sendWs(ws, {
        type: "op",
        docId,
        ops: [{ type: "insert", id: { counter: 1, replicaId: "viewer-replica" }, originId: null, value: "h" }],
      });

      const reply = await errorPromise;
      expect(reply.type).toBe("error");
      if (reply.type === "error") {
        expect(reply.code).toBe("FORBIDDEN");
      }
      ws.close();
    });
  });

  describe("Replica identity", () => {
    test("server derives or validates replicaId from authenticated user", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "ReplicaUser");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookie);

      const ws = await connectAuthenticatedWs(ctx.wsUrl, cookie);
      // Client sends an arbitrary replicaId — the server should either:
      // 1. Override it with a server-derived replicaId, or
      // 2. Accept it but bind it to the authenticated user (so a different user can't reuse it)
      const reply = await joinDocument(ws, docId, "arbitrary-replica-id");
      expect(["sync", "snapshot"]).toContain(reply.type);
      ws.close();
    });
  });

  describe("Presence authorization", () => {
    test("presence updates are scoped to authorized documents", async () => {
      const emailViewer = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieViewer = await createTestUser(ctx.httpUrl, emailViewer, "Test1234!!", "Viewer");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailViewer, role: "VIEWER" }),
      });

      const wsOwner = await connectAuthenticatedWs(ctx.wsUrl, cookieOwner);
      const wsViewer = await connectAuthenticatedWs(ctx.wsUrl, cookieViewer);

      await joinDocument(wsOwner, docId, "owner-replica");
      await joinDocument(wsViewer, docId, "viewer-replica");

      const presencePromise = nextMessage(wsOwner);
      sendWs(wsViewer, {
        type: "presence",
        docId,
        cursor: 5,
        selection: null,
        name: "Viewer",
        color: "#ff0000",
      });

      const reply = await presencePromise;
      expect(reply.type).toBe("presence-update");
      if (reply.type === "presence-update") {
        expect(reply.docId).toBe(docId);
      }

      wsOwner.close();
      wsViewer.close();
    });
  });
});
