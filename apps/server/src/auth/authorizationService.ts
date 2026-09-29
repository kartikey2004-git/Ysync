import type { PrismaClient } from "@ysync/database";
import { type DocumentPermission, hasPermission } from "./permissions.js";
import { ForbiddenError, DocumentNotFoundError } from "./errors.js";

export class AuthorizationService {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async getDocumentRole(userId: string, documentId: string) {
    const member = await this.prisma.documentMember.findUnique({
      where: { documentId_userId: { documentId, userId } },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  async canReadDocument(userId: string, documentId: string): Promise<boolean> {
    const role = await this.getDocumentRole(userId, documentId);
    return role !== null && hasPermission(role, "document:read");
  }

  async canWriteDocument(userId: string, documentId: string): Promise<boolean> {
    const role = await this.getDocumentRole(userId, documentId);
    return role !== null && hasPermission(role, "document:write");
  }

  async canManageMembers(userId: string, documentId: string): Promise<boolean> {
    const role = await this.getDocumentRole(userId, documentId);
    return role !== null && hasPermission(role, "document:manage_members");
  }

  async canDeleteDocument(userId: string, documentId: string): Promise<boolean> {
    const role = await this.getDocumentRole(userId, documentId);
    return role !== null && hasPermission(role, "document:delete");
  }

  async assertPermission(userId: string, documentId: string, permission: DocumentPermission): Promise<void> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true },
    });
    if (!doc) throw new DocumentNotFoundError(documentId);

    const role = await this.getDocumentRole(userId, documentId);
    if (role === null || !hasPermission(role, permission)) {
      throw new ForbiddenError(userId, documentId, permission);
    }
  }
}
