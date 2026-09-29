import { describe, expect, test } from "vitest";
import { DocumentRole } from "@ysync/database";
import { hasPermission, DocumentPermission } from "../src/auth/permissions.js";

describe("hasPermission (pure unit tests — no DB needed)", () => {
  describe("OWNER has all permissions", () => {
    test.each([
      DocumentPermission.Read,
      DocumentPermission.Write,
      DocumentPermission.ManageMembers,
      DocumentPermission.Delete,
      DocumentPermission.TransferOwnership,
    ] as const)("OWNER has %s", (perm) => {
      expect(hasPermission(DocumentRole.OWNER, perm)).toBe(true);
    });
  });

  describe("EDITOR has read and write only", () => {
    test("EDITOR has document:read", () => {
      expect(hasPermission(DocumentRole.EDITOR, DocumentPermission.Read)).toBe(true);
    });

    test("EDITOR has document:write", () => {
      expect(hasPermission(DocumentRole.EDITOR, DocumentPermission.Write)).toBe(true);
    });

    test("EDITOR cannot manage_members", () => {
      expect(hasPermission(DocumentRole.EDITOR, DocumentPermission.ManageMembers)).toBe(false);
    });

    test("EDITOR cannot delete", () => {
      expect(hasPermission(DocumentRole.EDITOR, DocumentPermission.Delete)).toBe(false);
    });

    test("EDITOR cannot transfer_ownership", () => {
      expect(hasPermission(DocumentRole.EDITOR, DocumentPermission.TransferOwnership)).toBe(false);
    });
  });

  describe("VIEWER has read only", () => {
    test("VIEWER has document:read", () => {
      expect(hasPermission(DocumentRole.VIEWER, DocumentPermission.Read)).toBe(true);
    });

    test("VIEWER cannot write", () => {
      expect(hasPermission(DocumentRole.VIEWER, DocumentPermission.Write)).toBe(false);
    });

    test("VIEWER cannot manage_members", () => {
      expect(hasPermission(DocumentRole.VIEWER, DocumentPermission.ManageMembers)).toBe(false);
    });

    test("VIEWER cannot delete", () => {
      expect(hasPermission(DocumentRole.VIEWER, DocumentPermission.Delete)).toBe(false);
    });

    test("VIEWER cannot transfer_ownership", () => {
      expect(hasPermission(DocumentRole.VIEWER, DocumentPermission.TransferOwnership)).toBe(false);
    });
  });

  describe("permission matrix is exhaustive", () => {
    const allRoles = [DocumentRole.OWNER, DocumentRole.EDITOR, DocumentRole.VIEWER] as const;
    const allPerms = [
      DocumentPermission.Read,
      DocumentPermission.Write,
      DocumentPermission.ManageMembers,
      DocumentPermission.Delete,
      DocumentPermission.TransferOwnership,
    ] as const;

    const expected: Record<string, Record<string, boolean>> = {
      OWNER: { "document:read": true, "document:write": true, "document:manage_members": true, "document:delete": true, "document:transfer_ownership": true },
      EDITOR: { "document:read": true, "document:write": true, "document:manage_members": false, "document:delete": false, "document:transfer_ownership": false },
      VIEWER: { "document:read": true, "document:write": false, "document:manage_members": false, "document:delete": false, "document:transfer_ownership": false },
    };

    for (const role of allRoles) {
      for (const perm of allPerms) {
        test(`${role} + ${perm} = ${expected[role]![perm]}`, () => {
          expect(hasPermission(role, perm)).toBe(expected[role]![perm]);
        });
      }
    }
  });
});
