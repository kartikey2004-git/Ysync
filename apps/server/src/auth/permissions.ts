import { DocumentRole } from "@ysync/database";

export const DocumentPermission = {
  Read: "document:read",
  Write: "document:write",
  ManageMembers: "document:manage_members",
  Delete: "document:delete",
  TransferOwnership: "document:transfer_ownership",
} as const;

export type DocumentPermission = (typeof DocumentPermission)[keyof typeof DocumentPermission];

const ROLE_PERMISSIONS: Record<DocumentRole, ReadonlySet<DocumentPermission>> = {
  [DocumentRole.OWNER]: new Set([
    DocumentPermission.Read,
    DocumentPermission.Write,
    DocumentPermission.ManageMembers,
    DocumentPermission.Delete,
    DocumentPermission.TransferOwnership,
  ]),
  [DocumentRole.EDITOR]: new Set([
    DocumentPermission.Read,
    DocumentPermission.Write,
  ]),
  [DocumentRole.VIEWER]: new Set([
    DocumentPermission.Read,
  ]),
};

export function hasPermission(role: DocumentRole, permission: DocumentPermission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
