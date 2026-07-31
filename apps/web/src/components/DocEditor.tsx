"use client";

import dynamic from "next/dynamic";
import { useDocument } from "@/lib/useDocument";
import { PresenceList } from "./PresenceList";

// Quill touches `document` at module-evaluation time, which crashes
// Next.js's SSR pass even for a "use client" component — ssr:false keeps
// it (and quill-delta) out of the server bundle entirely.
const Editor = dynamic(() => import("./Editor").then((mod) => mod.Editor), { ssr: false });

interface DocEditorProps {
  slug: string;
}

export function DocEditor({ slug }: DocEditorProps) {
  const { client, snapshot } = useDocument(slug);

  return (
    <main className="doc-page">
      <header className="doc-header">
        <h1>{slug}</h1>
        <div className="doc-header-controls">
          <PresenceList snapshot={snapshot} />
          <label className="offline-toggle">
            <input
              type="checkbox"
              checked={snapshot.simulatedOffline}
              onChange={(event) => client?.setSimulatedOffline(event.target.checked)}
              disabled={!client}
            />
            Simulate offline
          </label>
        </div>
      </header>
      {snapshot.lastError && <p className="doc-error">{snapshot.lastError}</p>}
      {client ? <Editor client={client} /> : <p>Loading…</p>}
    </main>
  );
}

