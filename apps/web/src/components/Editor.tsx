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

/**
 * Quill <-> CRDT binding (system-design.md §8.4). Local user edits go
 * straight through `deltaToEdits` into `client.insertText`/`deleteText` —
 * Quill has already applied the user's own edit to its own document, so
 * nothing gets written back to Quill for that path. Remote/reconciled
 * state changes are applied via a Delta diff (`quill.updateContents`)
 * rather than a full `setContents` replace, so the local cursor isn't
 * clobbered by someone else's edit.
 */
export function Editor({ client }: EditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = "";
    const editorEl = document.createElement("div");
    container.appendChild(editorEl);
    const quill = new Quill(editorEl, { theme: "snow" });

    quill.setContents(new Delta(client.getContentsForEditor()), "silent");

    const handleTextChange = (delta: QuillDelta, _oldDelta: unknown, source: string) => {
      if (source !== "user") return;
      for (const edit of deltaToEdits(delta)) {
        if (edit.kind === "insert") client.insertText(edit.index, edit.value);
        else client.deleteText(edit.index);
      }
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
