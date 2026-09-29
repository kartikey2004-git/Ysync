import { Router, json, type Request, type Response, type NextFunction } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { DocumentRole, type PrismaClient, type Prisma } from "@ysync/database";
import type { Auth } from "../auth/betterAuth.js";
import type { AuthorizationService } from "../auth/authorizationService.js";
import { DocumentPermission } from "../auth/permissions.js";
import { ForbiddenError, DocumentNotFoundError } from "../auth/errors.js";
import { logger } from "../logger.js";

interface AuthenticatedRequest extends Request {
  userId: string;
  sessionId: string;
}

function isAuthenticated(req: Request): req is AuthenticatedRequest {
  return "userId" in req && typeof (req as AuthenticatedRequest).userId === "string";
}

type TxClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export function createDocumentRouter(
  prisma: PrismaClient,
  authorizationService: AuthorizationService,
  auth: Auth,
): Router {
  const router = Router();
  router.use(json());

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });
      if (!session?.user?.id || !session.session?.id) {
        res.status(401).json({ error: "UNAUTHENTICATED", message: "authentication required" });
        return;
      }
      (req as AuthenticatedRequest).userId = session.user.id;
      (req as AuthenticatedRequest).sessionId = session.session.id;
      next();
    } catch {
      res.status(401).json({ error: "UNAUTHENTICATED", message: "authentication required" });
    }
  });

  function handleAuthError(res: Response, err: unknown): void {
    if (err instanceof DocumentNotFoundError || err instanceof ForbiddenError) {
      res.status(404).json({ error: "DOCUMENT_NOT_FOUND", message: "document not found" });
      return;
    }
    logger.error("unexpected error in document route", { error: String(err) });
    res.status(500).json({ error: "INTERNAL_ERROR", message: "internal error" });
  }

  router.post("/", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    try {
      const id = crypto.randomUUID();

      await prisma.$transaction([
        prisma.document.create({ data: { id } }),
        prisma.documentMember.create({
          data: { documentId: id, userId: req.userId, role: DocumentRole.OWNER },
        }),
      ]);

      logger.info("document created", { documentId: id, userId: req.userId });
      res.status(201).json({ id, role: "OWNER" });
    } catch (err) {
      logger.error("document creation failed", { userId: req.userId, error: String(err) });
      res.status(500).json({ error: "INTERNAL_ERROR", message: "failed to create document" });
    }
  });

  router.get("/", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    try {
      const memberships = await prisma.documentMember.findMany({
        where: { userId: req.userId },
        include: { document: { select: { id: true, latestSeq: true, createdAt: true, updatedAt: true } } },
        orderBy: { document: { updatedAt: "desc" } },
      });

      res.json(
        memberships.map((m: typeof memberships[number]) => ({
          id: m.document.id,
          role: m.role,
          createdAt: m.document.createdAt,
          updatedAt: m.document.updatedAt,
        })),
      );
    } catch (err) {
      logger.error("document listing failed", { userId: req.userId, error: String(err) });
      res.status(500).json({ error: "INTERNAL_ERROR", message: "failed to list documents" });
    }
  });

  router.get("/:id", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.Read);

      const doc = await prisma.document.findUniqueOrThrow({
        where: { id: documentId },
        select: { id: true, latestSeq: true, createdAt: true, updatedAt: true },
      });

      const role = await authorizationService.getDocumentRole(req.userId, documentId);
      const canManage = await authorizationService.canManageMembers(req.userId, documentId);

      let members: { userId: string; role: DocumentRole; name: string; email: string }[] | undefined;
      if (canManage) {
        const rows = await prisma.documentMember.findMany({
          where: { documentId },
          include: { user: { select: { name: true, email: true } } },
        });
        members = rows.map((r: typeof rows[number]) => ({ userId: r.userId, role: r.role, name: r.user.name, email: r.user.email }));
      }

      res.json({ ...doc, role, members });
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  router.delete("/:id", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.Delete);
      await prisma.document.delete({ where: { id: documentId } });
      logger.info("document deleted", { documentId, userId: req.userId });
      res.status(204).end();
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  router.get("/:id/members", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.ManageMembers);

      const rows = await prisma.documentMember.findMany({
        where: { documentId },
        include: { user: { select: { name: true, email: true } } },
        orderBy: { createdAt: "asc" },
      });

      res.json(rows.map((r: typeof rows[number]) => ({ userId: r.userId, role: r.role, name: r.user.name, email: r.user.email })));
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  router.post("/:id/members", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.ManageMembers);

      const { email, role } = req.body as { email?: string; role?: string };
      if (!email || !role) {
        res.status(400).json({ error: "BAD_REQUEST", message: "email and role are required" });
        return;
      }
      if (role !== "EDITOR" && role !== "VIEWER") {
        res.status(400).json({ error: "BAD_REQUEST", message: "role must be EDITOR or VIEWER" });
        return;
      }

      const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (!user) {
        res.status(404).json({ error: "USER_NOT_FOUND", message: "no user with that email" });
        return;
      }

      const existing = await prisma.documentMember.findUnique({
        where: { documentId_userId: { documentId, userId: user.id } },
      });
      if (existing) {
        res.status(409).json({ error: "ALREADY_MEMBER", message: "user is already a member of this document" });
        return;
      }

      const member = await prisma.documentMember.create({
        data: { documentId, userId: user.id, role: role as DocumentRole },
        include: { user: { select: { name: true, email: true } } },
      });

      logger.info("member added", { documentId, targetUserId: user.id, role, byUserId: req.userId });
      res.status(201).json({ userId: member.userId, role: member.role, name: member.user.name, email: member.user.email });
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  router.patch("/:id/members/:userId", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    const targetUserId = req.params.userId!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.ManageMembers);

      const existing = await prisma.documentMember.findUnique({
        where: { documentId_userId: { documentId, userId: targetUserId } },
      });
      if (!existing) {
        res.status(404).json({ error: "MEMBER_NOT_FOUND", message: "member not found" });
        return;
      }
      if (existing.role === DocumentRole.OWNER) {
        res.status(400).json({ error: "BAD_REQUEST", message: "cannot change owner role directly — use transfer-ownership" });
        return;
      }

      const { role } = req.body as { role?: string };
      if (role !== "EDITOR" && role !== "VIEWER") {
        res.status(400).json({ error: "BAD_REQUEST", message: "role must be EDITOR or VIEWER" });
        return;
      }

      const updated = await prisma.documentMember.update({
        where: { documentId_userId: { documentId, userId: targetUserId } },
        data: { role: role as DocumentRole },
        include: { user: { select: { name: true, email: true } } },
      });

      logger.info("member role updated", { documentId, targetUserId, newRole: role, byUserId: req.userId });
      res.json({ userId: updated.userId, role: updated.role, name: updated.user.name, email: updated.user.email });
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  router.delete("/:id/members/:userId", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    const targetUserId = req.params.userId!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.ManageMembers);

      const existing = await prisma.documentMember.findUnique({
        where: { documentId_userId: { documentId, userId: targetUserId } },
      });
      if (!existing) {
        res.status(404).json({ error: "MEMBER_NOT_FOUND", message: "member not found" });
        return;
      }
      if (existing.role === DocumentRole.OWNER) {
        res.status(400).json({ error: "BAD_REQUEST", message: "cannot remove the document owner" });
        return;
      }

      await prisma.documentMember.delete({
        where: { documentId_userId: { documentId, userId: targetUserId } },
      });

      logger.info("member removed", { documentId, targetUserId, byUserId: req.userId });
      res.status(204).end();
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  router.post("/:id/transfer-ownership", async (req: Request, res: Response) => {
    if (!isAuthenticated(req)) return;
    const documentId = req.params.id!;
    try {
      await authorizationService.assertPermission(req.userId, documentId, DocumentPermission.TransferOwnership);

      const { newOwnerId } = req.body as { newOwnerId?: string };
      if (!newOwnerId) {
        res.status(400).json({ error: "BAD_REQUEST", message: "newOwnerId is required" });
        return;
      }
      if (newOwnerId === req.userId) {
        res.status(400).json({ error: "BAD_REQUEST", message: "you are already the owner" });
        return;
      }

      await prisma.$transaction(async (tx: TxClient) => {
        const newOwnerMember = await tx.documentMember.findUnique({
          where: { documentId_userId: { documentId, userId: newOwnerId } },
        });
        if (!newOwnerMember) {
          throw new DocumentNotFoundError(documentId);
        }

        await tx.documentMember.update({
          where: { documentId_userId: { documentId, userId: req.userId } },
          data: { role: DocumentRole.EDITOR },
        });

        await tx.documentMember.update({
          where: { documentId_userId: { documentId, userId: newOwnerId } },
          data: { role: DocumentRole.OWNER },
        });
      });

      logger.info("ownership transferred", { documentId, fromUserId: req.userId, toUserId: newOwnerId });
      res.json({ transferred: true });
    } catch (err) {
      handleAuthError(res, err);
    }
  });

  return router;
}
