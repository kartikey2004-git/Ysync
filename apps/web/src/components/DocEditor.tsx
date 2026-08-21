"use client";

import dynamic from "next/dynamic";
import { useDocument } from "@/lib/useDocument";
import { PresenceList } from "./PresenceList";

// Quill touches `document` at module-evaluation time, which crashes Next.js's SSR pass despite this being a "use client" component — ssr:false keeps it (and quill-delta) out of the server bundle entirely
const Editor = dynamic(() => import("./Editor").then((mod) => mod.Editor), { ssr: false });

interface DocEditorProps {
  slug: string;
}

export function DocEditor({ slug }: DocEditorProps) {
  const { client, snapshot } = useDocument(slug);

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
          <PresenceList snapshot={snapshot} />
        </div>

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
      </header>

      {snapshot.lastError && (
        <p className="border-l-2 border-black bg-neutral-50 px-4 py-3 text-sm text-black">
          {snapshot.lastError}
        </p>
      )}

      {client ? (
        <Editor client={client} />
      ) : (
        <p className="border border-neutral-200 bg-white py-24 text-center text-sm text-neutral-400">
          Loading…
        </p>
      )}
    </main>
  );
}
