"use client";

import { useEffect, useRef } from "react";
import Quill from "quill";
import Delta from "quill-delta";
import "quill/dist/quill.snow.css";
import type { DocumentClient } from "@/lib/documentClient";
import { deltaToEdits, type QuillDelta } from "@/lib/deltaToEdits";

interface EditorProps {
  client: DocumentClient;
}

// Quill aur CRDT ke beech ka binding hai. Local user edits seedha
// deltaToEdits se ho ke client.applyLocalEdits mein ek batch ki tarah jaate
// hain — Quill apna edit apne document pe already apply kar chuka hota hai,
// isliye us path pe Quill mein kuch wapas likhna nahi padta, aur beech mein
// notify karne se neeche wala remote-sync path half-applied edit ke saath
// race kar sakta hai. Remote/reconciled changes Delta diff (quill.updateContents)
// se aate hain, poora setContents replace nahi karte, taaki local cursor na hile.
export function Editor({ client }: EditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // React StrictMode mein effect double-run hota hai, purana Quill instance
    // ka DOM saaf kar do warna do editors ek saath dikhne lagenge
    container.innerHTML = "";
    const editorEl = document.createElement("div");
    container.appendChild(editorEl);
    const quill = new Quill(editorEl, { theme: "snow" });

    // "silent" isliye taaki initial load pe text-change event fire na ho, warna
    // apna hi loaded content dobara applyLocalEdits mein chala jayega
    quill.setContents(new Delta(client.getContentsForEditor()), "silent");

    const handleTextChange = (delta: QuillDelta, _oldDelta: unknown, source: string) => {
      // source "api" hoga jab hum khud updateContents call karte hain (remote sync) —
      // sirf real user typing yahan se aage badhni chahiye
      if (source !== "user") return;
      client.applyLocalEdits(deltaToEdits(delta));
    };
    quill.on("text-change", handleTextChange);

    const handleSelectionChange = (range: { index: number; length: number } | null, _oldRange: unknown, source: string) => {
      if (source !== "user") return;
      if (range == null) {
        client.updatePresence(null, null);
      } else {
        client.updatePresence(range.index, { anchor: range.index, head: range.index + range.length });
      }
    };
    quill.on("selection-change", handleSelectionChange);

    // client change hote hi (remote op, presence, jo bhi) yeh fire hota hai —
    // diff nikal ke sirf jo actually badla wahi Quill mein daalo, cursor position bachi rahe
    const unsubscribe = client.subscribe(() => {
      const currentDelta = quill.getContents();
      const nextDelta = new Delta(client.getContentsForEditor());
      const diff = currentDelta.diff(nextDelta);
      if (diff.ops.length > 0) {
        quill.updateContents(diff, "silent");
      }
    });

    return () => {
      quill.off("text-change", handleTextChange);
      quill.off("selection-change", handleSelectionChange);
      unsubscribe();
      container.innerHTML = "";
    };
  }, [client]);

  return <div ref={containerRef} className="editor" />;
}
