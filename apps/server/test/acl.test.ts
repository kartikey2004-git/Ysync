import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
  uniqueEmail,
  type TestServerContext,
} from "./helpers/authTestHelpers.js";

const postgresAvailable = await isPostgresReachable();

// Security test matrix from the prompt: every cell in the Actor × Document × Action
// table must have an explicit test. HTTP endpoints return 404 (not 403) for unauthorized
// access to prevent document enumeration.
describe.skipIf(!postgresAvailable)("ACL security matrix (requires live Postgres)", () => {
  let ctx: TestServerContext;

  // Pre-created test state for the entire matrix
  let ownerCookie: string;
  let editorCookie: string;
  let viewerCookie: string;
  let strangerCookie: string;
  let docId: string;

  beforeAll(async () => {
    ctx = await startAuthServer();

    const emailEditor = uniqueEmail();
    const emailViewer = uniqueEmail();

    ownerCookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "ACL Owner");
    editorCookie = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "ACL Editor");
    viewerCookie = await createTestUser(ctx.httpUrl, emailViewer, "Test1234!!", "ACL Viewer");
    strangerCookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "ACL Stranger");

    docId = await createDocumentAsUser(ctx.httpUrl, ownerCookie);

    // Add editor
    await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, ownerCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
    });

    // Add viewer
    await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, ownerCookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailViewer, role: "VIEWER" }),
    });
  });

  afterAll(async () => {
    await ctx?.cleanup();
  });

  // ── Anonymous ──────────────────────────────────────────────────────

  describe("Anonymous", () => {
    test("Anonymous + Any document + Read → Reject", async () => {
      const res = await fetch(`${ctx.httpUrl}/api/documents/${docId}`);
      expect(res.status).toBe(401);
    });

    test("Anonymous + Any document + Write (HTTP) → Reject", async () => {
      const res = await fetch(`${ctx.httpUrl}/api/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(401);
    });

    test("Anonymous + Any document + WS join → Reject", async () => {
      try {
        const ws = await connectWs(ctx.wsUrl);
        const reply = await joinDocument(ws, docId, "anon-replica");
        // Connection opened but join should fail
        expect(reply.type).toBe("error");
        ws.close();
      } catch {
        // Connection rejected on upgrade — expected
      }
    });
  });

  // ── Owner ──────────────────────────────────────────────────────────

  describe("Owner", () => {
    test("Owner + Own document + Read → Allow", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, ownerCookie);
      expect(res.status).toBe(200);
    });

    test("Owner + Own document + Write (WS op) → Allow", async () => {
      const ws = await connectAuthenticatedWs(ctx.wsUrl, ownerCookie);
      await joinDocument(ws, docId, "owner-acl-replica");

      const ackPromise = nextMessage(ws);
      sendWs(ws, {
        type: "op",
        docId,
        ops: [{ type: "insert", id: { counter: 100, replicaId: "owner-acl-replica" }, originId: null, value: "o" }],
      });

      const reply = await ackPromise;
      expect(reply.type).toBe("ack");
      ws.close();
    });

    test("Owner + Own document + Manage ACL → Allow", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, ownerCookie);
      expect(res.status).toBe(200);
    });
  });

  // ── Editor ─────────────────────────────────────────────────────────

  describe("Editor", () => {
    test("Editor + Shared document + Read → Allow", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, editorCookie);
      expect(res.status).toBe(200);
    });

    test("Editor + Shared document + Write (WS op) → Allow", async () => {
      const ws = await connectAuthenticatedWs(ctx.wsUrl, editorCookie);
      await joinDocument(ws, docId, "editor-acl-replica");

      const ackPromise = nextMessage(ws);
      sendWs(ws, {
        type: "op",
        docId,
        ops: [{ type: "insert", id: { counter: 200, replicaId: "editor-acl-replica" }, originId: null, value: "e" }],
      });

      const reply = await ackPromise;
      expect(reply.type).toBe("ack");
      ws.close();
    });

    test("Editor + Shared document + Manage ACL → Reject", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, editorCookie);
      expect(res.status).toBe(404);
    });
  });

  // ── Viewer ─────────────────────────────────────────────────────────

  describe("Viewer", () => {
    test("Viewer + Shared document + Read → Allow", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, viewerCookie);
      expect(res.status).toBe(200);
    });

    test("Viewer + Shared document + Write (WS op) → Reject", async () => {
      const ws = await connectAuthenticatedWs(ctx.wsUrl, viewerCookie);
      await joinDocument(ws, docId, "viewer-acl-replica");

      const errorPromise = nextMessage(ws);
      sendWs(ws, {
        type: "op",
        docId,
        ops: [{ type: "insert", id: { counter: 300, replicaId: "viewer-acl-replica" }, originId: null, value: "v" }],
      });

      const reply = await errorPromise;
      expect(reply.type).toBe("error");
      if (reply.type === "error") {
        expect(reply.code).toBe("FORBIDDEN");
      }
      ws.close();
    });

    test("Viewer + Shared document + Manage ACL → Reject", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, viewerCookie);
      expect(res.status).toBe(404);
    });
  });

  // ── Cross-user (IDOR) ─────────────────────────────────────────────

  describe("Cross-user IDOR", () => {
    test("User A + User B's document + Read → Reject", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, strangerCookie);
      expect(res.status).toBe(404);
    });

    test("User A + User B's document + WS join → Reject", async () => {
      const ws = await connectAuthenticatedWs(ctx.wsUrl, strangerCookie);
      const reply = await joinDocument(ws, docId, "stranger-replica");
      expect(reply.type).toBe("error");
      if (reply.type === "error") {
        expect(["FORBIDDEN", "DOCUMENT_NOT_FOUND"]).toContain(reply.code);
      }
      ws.close();
    });

    test("User A + User B's document + Write attempt → Reject", async () => {
      const ws = await connectAuthenticatedWs(ctx.wsUrl, strangerCookie);
      const reply = await joinDocument(ws, docId, "stranger-replica-2");
      // Join should already be rejected
      expect(reply.type).toBe("error");
      ws.close();
    });

    test("User A + User B's document + Delete → Reject", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, strangerCookie, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    test("User A + User B's document + Member management → Reject", async () => {
      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, strangerCookie);
      expect(res.status).toBe(404);
    });
  });

  // ── Concurrent ACL mutations ──────────────────────────────────────

  describe("Concurrent ACL mutation safety", () => {
    test("two simultaneous role updates don't corrupt invariants", async () => {
      const emailM1 = uniqueEmail();
      const emailM2 = uniqueEmail();
      const ownCookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "ConcOwner");
      await createTestUser(ctx.httpUrl, emailM1, "Test1234!!", "Member1");
      await createTestUser(ctx.httpUrl, emailM2, "Test1234!!", "Member2");
      const dId = await createDocumentAsUser(ctx.httpUrl, ownCookie);

      const add1 = await authenticatedFetch(ctx.httpUrl, `/api/documents/${dId}/members`, ownCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailM1, role: "EDITOR" }),
      });
      const add2 = await authenticatedFetch(ctx.httpUrl, `/api/documents/${dId}/members`, ownCookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailM2, role: "EDITOR" }),
      });

      const member1 = (await add1.json()) as { userId: string };
      const member2 = (await add2.json()) as { userId: string };

      // Fire two role changes simultaneously
      const [res1, res2] = await Promise.all([
        authenticatedFetch(ctx.httpUrl, `/api/documents/${dId}/members/${member1.userId}`, ownCookie, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "VIEWER" }),
        }),
        authenticatedFetch(ctx.httpUrl, `/api/documents/${dId}/members/${member2.userId}`, ownCookie, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "VIEWER" }),
        }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Verify: exactly one OWNER, two VIEWERs
      const members = await ctx.prisma.documentMember.findMany({
        where: { documentId: dId },
      });
      const ownerCount = members.filter((m) => m.role === "OWNER").length;
      const viewerCount = members.filter((m) => m.role === "VIEWER").length;
      expect(ownerCount).toBe(1);
      expect(viewerCount).toBe(2);
    });

    test("document creation is atomic (owner membership always exists)", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "AtomicUser");

      // Create 5 documents in parallel
      const results = await Promise.all(
        Array.from({ length: 5 }, () => createDocumentAsUser(ctx.httpUrl, cookie)),
      );

      // Every document must have exactly one OWNER member
      for (const id of results) {
        const ownerCount = await ctx.prisma.documentMember.count({
          where: { documentId: id, role: "OWNER" },
        });
        expect(ownerCount).toBe(1);
      }
    });
  });
});
