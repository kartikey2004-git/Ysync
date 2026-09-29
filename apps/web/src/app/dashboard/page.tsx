"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { createDocument, listDocuments, type DocumentInfo } from "@/lib/api";

const ROLE_STYLES: Record<string, string> = {
  OWNER: "bg-black text-white",
  EDITOR: "bg-neutral-200 text-black",
  VIEWER: "bg-neutral-100 text-neutral-600",
};

export default function DashboardPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isPending && !session) {
      router.push("/auth/signin");
    }
  }, [isPending, session, router]);

  useEffect(() => {
    if (!session) return;
    listDocuments()
      .then(setDocuments)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [session]);

  async function handleCreate() {
    setCreating(true);
    try {
      const doc = await createDocument();
      router.push(`/doc/${doc.id}`);
    } catch {
      setCreating(false);
    }
  }

  async function handleSignOut() {
    await authClient.signOut();
    router.push("/auth/signin");
  }

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-neutral-400">Loading...</p>
      </div>
    );
  }

  if (!session) return null;

  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl px-4 py-10 sm:px-6">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-6">
        <div>
          <Link href="/" className="text-xs font-medium uppercase tracking-[0.22em] text-neutral-500">
            YSync
          </Link>
          <h1 className="mt-1 text-2xl font-medium tracking-tight text-black">Documents</h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-neutral-500">{session.user.name}</span>
          <button
            onClick={handleSignOut}
            className="border border-neutral-300 px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-neutral-600 transition hover:border-black hover:text-black"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="mt-6 flex items-center justify-between">
        <p className="text-sm text-neutral-500">
          {loading ? "Loading..." : `${documents.length} document${documents.length !== 1 ? "s" : ""}`}
        </p>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="border border-black bg-black px-4 py-2 text-xs font-medium uppercase tracking-wider text-white transition hover:bg-neutral-800 disabled:opacity-50"
        >
          {creating ? "Creating..." : "New document"}
        </button>
      </div>

      {!loading && documents.length === 0 && (
        <div className="mt-16 text-center">
          <p className="text-sm text-neutral-400">No documents yet</p>
          <p className="mt-1 text-xs text-neutral-400">Create one to get started</p>
        </div>
      )}

      {!loading && documents.length > 0 && (
        <ul className="mt-4 divide-y divide-neutral-100">
          {documents.map((doc) => (
            <li key={doc.id}>
              <Link
                href={`/doc/${doc.id}`}
                className="flex items-center justify-between gap-4 py-4 transition hover:bg-neutral-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm text-black">{doc.id}</p>
                  <p className="mt-0.5 text-xs text-neutral-400">
                    {new Date(doc.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span
                  className={`inline-block px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${ROLE_STYLES[doc.role] ?? ROLE_STYLES.VIEWER}`}
                >
                  {doc.role}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
