"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useDocument } from "@/lib/useDocument";
import { useSession } from "@/lib/auth-client";
import { getDocument } from "@/lib/api";
import { PresenceList } from "./PresenceList";
import { MemberManager } from "./MemberManager";

const Editor = dynamic(() => import("./Editor").then((mod) => mod.Editor), { ssr: false });

interface DocEditorProps {
  slug: string;
}

export function DocEditor({ slug }: DocEditorProps) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const [role, setRole] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);

  useEffect(() => {
    if (sessionPending) return;
    if (!session?.user) {
      router.push(`/auth/signin?redirect=/doc/${slug}`);
      return;
    }
    getDocument(slug)
      .then((doc) => setRole(doc.role))
      .catch(() => setLoadError("Document not found or you don't have access."));
  }, [slug, session, sessionPending, router]);

  const { client, snapshot } = useDocument(slug, session?.user?.id ?? null);

  const readOnly = role === "VIEWER";
  const isOwner = role === "OWNER";

  if (sessionPending) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-neutral-400">Loading session…</p>
      </main>
    );
  }

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-sm text-neutral-600">{loadError}</p>
        <button
          type="button"
          onClick={() => router.push("/dashboard")}
          className="border border-neutral-300 px-4 py-2 text-sm hover:border-neutral-400"
        >
          Back to dashboard
        </button>
      </main>
    );
  }

  if (!role) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-neutral-400">Loading document…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6 lg:px-10">
      <header className="flex flex-col gap-5 border-b border-neutral-200 pb-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <span className="text-xs font-medium uppercase tracking-[0.22em] text-neutral-500">
              Document
            </span>
            <h1 className="mt-1 max-w-full truncate text-2xl font-medium tracking-tight text-black sm:text-3xl">
              {slug}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex items-center px-2 py-0.5 text-xs font-medium uppercase tracking-wider ${
              role === "OWNER"
                ? "bg-black text-white"
                : role === "EDITOR"
                  ? "bg-neutral-200 text-neutral-700"
                  : "bg-neutral-100 text-neutral-500"
            }`}>
              {role}
            </span>
            <PresenceList snapshot={snapshot} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {isOwner && (
            <button
              type="button"
              onClick={() => setShowMembers(!showMembers)}
              className="inline-flex w-fit items-center gap-2 border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-neutral-600 transition hover:border-neutral-400"
            >
              Members
            </button>
          )}
          <button
            type="button"
            onClick={() => client?.setSimulatedOffline(!snapshot.simulatedOffline)}
            disabled={!client}
            aria-pressed={snapshot.simulatedOffline}
            className={`inline-flex w-fit items-center gap-2 border px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-40 ${
              snapshot.simulatedOffline
                ? "border-black bg-black text-white"
                : "border-neutral-300 bg-white text-neutral-600 hover:border-neutral-400"
            }`}
          >
            <span className={`h-1.5 w-1.5 ${snapshot.simulatedOffline ? "bg-white" : "bg-neutral-400"}`} />
            Simulate offline
          </button>
        </div>
      </header>

      {showMembers && isOwner && (
        <MemberManager docId={slug} isOwner={isOwner} />
      )}

      {snapshot.lastError && (
        <p className="border-l-2 border-black bg-neutral-50 px-4 py-3 text-sm text-black">
          {snapshot.lastError}
        </p>
      )}

      {readOnly && (
        <p className="border border-neutral-200 bg-neutral-50 px-4 py-2 text-xs text-neutral-500">
          You have view-only access to this document.
        </p>
      )}

      {client ? (
        <Editor client={client} readOnly={readOnly} />
      ) : (
        <p className="border border-neutral-200 bg-white py-24 text-center text-sm text-neutral-400">
          Loading…
        </p>
      )}
    </main>
  );
}
