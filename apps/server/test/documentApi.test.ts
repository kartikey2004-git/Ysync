import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DocumentRole } from "@ysync/database";
import {
  isPostgresReachable,
  startAuthServer,
  createTestUser,
  authenticatedFetch,
  createDocumentAsUser,
  uniqueEmail,
  type TestServerContext,
} from "./helpers/authTestHelpers.js";

const postgresAvailable = await isPostgresReachable();

describe.skipIf(!postgresAvailable)("Document API (requires live Postgres)", () => {
  let ctx: TestServerContext;

  beforeAll(async () => {
    ctx = await startAuthServer();
  });

  afterAll(async () => {
    await ctx?.cleanup();
  });

  describe("Document CRUD", () => {
    test("POST /api/documents creates a document with caller as OWNER", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Doc Creator");
      const res = await authenticatedFetch(ctx.httpUrl, "/api/documents", cookie, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; role: string };
      expect(body.id).toBeTruthy();
      expect(body.role).toBe("OWNER");
    });

    test("GET /api/documents lists only the user's documents", async () => {
      const cookieA = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "User A");
      const cookieB = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "User B");

      const docIdA = await createDocumentAsUser(ctx.httpUrl, cookieA);
      await createDocumentAsUser(ctx.httpUrl, cookieB);

      const res = await authenticatedFetch(ctx.httpUrl, "/api/documents", cookieA);
      const body = (await res.json()) as { id: string }[];
      expect(body).toHaveLength(1);
      expect(body[0]!.id).toBe(docIdA);
    });

    test("GET /api/documents/:id returns the document for an authorized user", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Reader");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookie);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; role: string };
      expect(body.id).toBe(docId);
      expect(body.role).toBe("OWNER");
    });

    test("GET /api/documents/:id returns 404 for an unauthorized user (IDOR prevention)", async () => {
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieStranger = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Stranger");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookieStranger);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("DOCUMENT_NOT_FOUND");
    });

    test("GET /api/documents/:id returns 404 for a nonexistent document", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "LostUser");

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/nonexistent-id`, cookie);
      expect(res.status).toBe(404);
    });

    test("DELETE /api/documents/:id works for OWNER", async () => {
      const cookie = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Deleter");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookie);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookie, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);

      const getRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookie);
      expect(getRes.status).toBe(404);
    });

    test("DELETE /api/documents/:id returns 404 for EDITOR", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookieEditor, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });

    test("DELETE /api/documents/:id returns 404 for a non-member", async () => {
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieNonMember = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "NonMember");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookieNonMember, {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Member management", () => {
    test("GET /:id/members works for OWNER", async () => {
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string }[];
      expect(body.length).toBeGreaterThanOrEqual(1);
      expect(body.some((m) => m.role === "OWNER")).toBe(true);
    });

    test("GET /:id/members returns 404 for EDITOR (can't manage)", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieEditor);
      expect(res.status).toBe(404);
    });

    test("POST /:id/members adds a member (OWNER only)", async () => {
      const emailNewMember = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      await createTestUser(ctx.httpUrl, emailNewMember, "Test1234!!", "New Member");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailNewMember, role: "EDITOR" }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as { role: string; email: string };
      expect(body.role).toBe("EDITOR");
      expect(body.email).toBe(emailNewMember);
    });

    test("POST /:id/members rejects OWNER as role", async () => {
      const emailNewMember = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      await createTestUser(ctx.httpUrl, emailNewMember, "Test1234!!", "Wannabe Owner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailNewMember, role: "OWNER" }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("BAD_REQUEST");
    });

    test("POST /:id/members is rejected for EDITOR (403 / 404)", async () => {
      const emailEditor = uniqueEmail();
      const emailTarget = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      await createTestUser(ctx.httpUrl, emailTarget, "Test1234!!", "Target");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });

      const res = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieEditor, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailTarget, role: "VIEWER" }),
      });

      expect(res.status).toBe(404);
    });

    test("PATCH /:id/members/:userId changes role (OWNER only)", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const addRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });
      const member = (await addRes.json()) as { userId: string };

      const res = await authenticatedFetch(
        ctx.httpUrl,
        `/api/documents/${docId}/members/${member.userId}`,
        cookieOwner,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "VIEWER" }),
        },
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string };
      expect(body.role).toBe("VIEWER");
    });

    test("PATCH /:id/members/:userId cannot change OWNER's role directly", async () => {
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const membersRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner);
      const members = (await membersRes.json()) as { userId: string; role: string }[];
      const ownerMember = members.find((m) => m.role === "OWNER")!;

      const res = await authenticatedFetch(
        ctx.httpUrl,
        `/api/documents/${docId}/members/${ownerMember.userId}`,
        cookieOwner,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: "EDITOR" }),
        },
      );

      expect(res.status).toBe(400);
    });

    test("DELETE /:id/members/:userId removes a member (OWNER only)", async () => {
      const emailViewer = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieViewer = await createTestUser(ctx.httpUrl, emailViewer, "Test1234!!", "Viewer");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const addRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailViewer, role: "VIEWER" }),
      });
      const member = (await addRes.json()) as { userId: string };

      const res = await authenticatedFetch(
        ctx.httpUrl,
        `/api/documents/${docId}/members/${member.userId}`,
        cookieOwner,
        { method: "DELETE" },
      );
      expect(res.status).toBe(204);

      const checkRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}`, cookieViewer);
      expect(checkRes.status).toBe(404);
    });

    test("DELETE /:id/members/:userId cannot remove the OWNER", async () => {
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const membersRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner);
      const members = (await membersRes.json()) as { userId: string; role: string }[];
      const ownerMember = members.find((m) => m.role === "OWNER")!;

      const res = await authenticatedFetch(
        ctx.httpUrl,
        `/api/documents/${docId}/members/${ownerMember.userId}`,
        cookieOwner,
        { method: "DELETE" },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("Ownership transfer", () => {
    test("POST /:id/transfer-ownership works for OWNER", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const addRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });
      const member = (await addRes.json()) as { userId: string };

      const res = await authenticatedFetch(
        ctx.httpUrl,
        `/api/documents/${docId}/transfer-ownership`,
        cookieOwner,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newOwnerId: member.userId }),
        },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transferred: boolean };
      expect(body.transferred).toBe(true);
    });

    test("after transfer, old owner becomes EDITOR, new owner becomes OWNER", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "OldOwner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "NewOwner");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const addRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });
      const member = (await addRes.json()) as { userId: string };

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/transfer-ownership`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerId: member.userId }),
      });

      // new owner can now manage members
      const membersRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieEditor);
      expect(membersRes.status).toBe(200);
      const members = (await membersRes.json()) as { role: string }[];

      const ownerCount = members.filter((m) => m.role === "OWNER").length;
      const editorCount = members.filter((m) => m.role === "EDITOR").length;
      expect(ownerCount).toBe(1);
      expect(editorCount).toBeGreaterThanOrEqual(1);
    });

    test("exactly one OWNER exists after transfer", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const addRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });
      const member = (await addRes.json()) as { userId: string };

      await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/transfer-ownership`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newOwnerId: member.userId }),
      });

      const ownerCount = await ctx.prisma.documentMember.count({
        where: { documentId: docId, role: DocumentRole.OWNER },
      });
      expect(ownerCount).toBe(1);
    });

    test("non-owner cannot transfer ownership", async () => {
      const emailEditor = uniqueEmail();
      const cookieOwner = await createTestUser(ctx.httpUrl, uniqueEmail(), "Test1234!!", "Owner");
      const cookieEditor = await createTestUser(ctx.httpUrl, emailEditor, "Test1234!!", "Editor");
      const docId = await createDocumentAsUser(ctx.httpUrl, cookieOwner);

      const addRes = await authenticatedFetch(ctx.httpUrl, `/api/documents/${docId}/members`, cookieOwner, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailEditor, role: "EDITOR" }),
      });
      const member = (await addRes.json()) as { userId: string };

      // editor tries to transfer — should fail
      const res = await authenticatedFetch(
        ctx.httpUrl,
        `/api/documents/${docId}/transfer-ownership`,
        cookieEditor,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newOwnerId: member.userId }),
        },
      );
      expect(res.status).toBe(404);
    });
  });
});
