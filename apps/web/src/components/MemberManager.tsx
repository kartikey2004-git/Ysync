"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  listMembers,
  addMember,
  updateMemberRole,
  removeMember,
  transferOwnership,
  type Member,
} from "@/lib/api";

interface MemberManagerProps {
  docId: string;
  isOwner: boolean;
}

const ROLE_STYLES: Record<string, string> = {
  OWNER: "bg-black text-white",
  EDITOR: "bg-neutral-200 text-black",
  VIEWER: "bg-neutral-100 text-neutral-600",
};

export function MemberManager({ docId, isOwner }: MemberManagerProps) {
  const [members, setMembers] = useState<Member[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("EDITOR");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [transferTarget, setTransferTarget] = useState<string | null>(null);

  useEffect(() => {
    listMembers(docId)
      .then(setMembers)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [docId]);

  if (!isOwner) return null;

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const member = await addMember(docId, email.trim(), role);
      setMembers((prev) => [...prev, member]);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add member");
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      const updated = await updateMemberRole(docId, userId, newRole);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role: updated.role } : m)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update role");
    }
  }

  async function handleRemove(userId: string) {
    try {
      await removeMember(docId, userId);
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove member");
    }
  }

  async function handleTransfer(newOwnerId: string) {
    try {
      await transferOwnership(docId, newOwnerId);
      setTransferTarget(null);
      const refreshed = await listMembers(docId);
      setMembers(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to transfer ownership");
    }
  }

  return (
    <div className="border border-neutral-200 bg-white">
      <div className="border-b border-neutral-200 px-4 py-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">Members</h3>
      </div>

      {error && (
        <p className="border-b border-neutral-100 bg-neutral-50 px-4 py-2 text-xs text-black">
          {error}
        </p>
      )}

      {loading ? (
        <p className="px-4 py-6 text-center text-xs text-neutral-400">Loading members...</p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-black">{m.name || m.email}</p>
                <p className="truncate text-xs text-neutral-400">{m.email}</p>
              </div>

              {m.role === "OWNER" ? (
                <span className={`px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${ROLE_STYLES.OWNER}`}>
                  Owner
                </span>
              ) : (
                <>
                  <select
                    value={m.role}
                    onChange={(e) => handleRoleChange(m.userId, e.target.value)}
                    className="border border-neutral-200 bg-white px-2 py-1 text-xs text-black outline-none"
                  >
                    <option value="EDITOR">Editor</option>
                    <option value="VIEWER">Viewer</option>
                  </select>

                  <button
                    onClick={() => handleRemove(m.userId)}
                    className="text-xs text-neutral-400 transition hover:text-black"
                    title="Remove member"
                  >
                    Remove
                  </button>

                  {transferTarget === m.userId ? (
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleTransfer(m.userId)}
                        className="border border-black bg-black px-2 py-0.5 text-[10px] font-medium text-white"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setTransferTarget(null)}
                        className="border border-neutral-300 px-2 py-0.5 text-[10px] text-neutral-600"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setTransferTarget(m.userId)}
                      className="text-[10px] text-neutral-400 transition hover:text-black"
                    >
                      Make owner
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex items-end gap-2 border-t border-neutral-200 px-4 py-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email address"
          className="min-w-0 flex-1 border border-neutral-300 bg-white px-3 py-1.5 text-sm text-black outline-none transition focus:border-black"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="border border-neutral-300 bg-white px-2 py-1.5 text-xs text-black outline-none"
        >
          <option value="EDITOR">Editor</option>
          <option value="VIEWER">Viewer</option>
        </select>
        <button
          type="submit"
          className="border border-black bg-black px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-white transition hover:bg-neutral-800"
        >
          Add
        </button>
      </form>
    </div>
  );
}
