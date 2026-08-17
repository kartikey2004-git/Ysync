"use client";

import dynamic from "next/dynamic";
import { useDocument } from "@/lib/useDocument";
import { PresenceList } from "./PresenceList";

// Quill module-evaluation ke waqt hi `document` ko touch kar leta hai, jisse
// Next.js ka SSR pass crash ho jata hai, "use client" component hone ke bawajood —
// ssr:false laga ke isko (aur quill-delta ko) server bundle se poori tarah bahar rakha hai
const Editor = dynamic(() => import("./Editor").then((mod) => mod.Editor), { ssr: false });

interface DocEditorProps {
  slug: string;
}

export function DocEditor({ slug }: DocEditorProps) {
  const { client, snapshot } = useDocument(slug);

  return (
    <main className="doc-page">
      <header className="doc-header">
        <span className="eyebrow">Document</span>
        <h1>{slug}</h1>
        <div className="doc-header-controls">
          <PresenceList snapshot={snapshot} />
          <label className="offline-toggle">
            <input
              type="checkbox"
              checked={snapshot.simulatedOffline}
              onChange={(event) => client?.setSimulatedOffline(event.target.checked)}
              disabled={!client} // client abhi banna baaki hai (browser-only effect), tab tak toggle useless hai
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

