"use client";

import { useEffect, useRef } from "react";
import Quill from "quill";
import Delta from "quill-delta";
import QuillCursors from "quill-cursors";
import "quill/dist/quill.snow.css";
import "quill-cursors/css";
import type { DocumentClient, RemotePresence } from "@/lib/documentClient";
import { deltaToEdits, type QuillDelta } from "@/lib/deltaToEdits";

Quill.register("modules/cursors", QuillCursors);

interface EditorProps {
  client: DocumentClient;
}

// a selection's {anchor, head} can be in either order (the user can select right-to-left too) — Quill/quill-cursors always need {index, length}
function toQuillRange(
  selection: RemotePresence["selection"],
): { index: number; length: number } | null {
  if (!selection) return null;
  const index = Math.min(selection.anchor, selection.head);
  const length = Math.abs(selection.head - selection.anchor);
  return { index, length };
}

// The binding between Quill and the CRDT. Local user edits go straight through deltaToEdits into client.applyLocalEdits as one batch — Quill has already applied the edit to its own document, so nothing needs to be written back to Quill on that path, and notifying in between would race the remote-sync path below against a half-applied edit. Remote/reconciled changes come in as a Delta diff (quill.updateContents), never a full setContents replace, so the local cursor doesn't jump.
export function Editor({ client }: EditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // React StrictMode double-runs effects, so clear out any previous Quill instance's DOM or two editors end up showing at once
    container.innerHTML = "";
    const editorEl = document.createElement("div");
    container.appendChild(editorEl);
    const quill = new Quill(editorEl, {
      theme: "snow",
      modules: { cursors: true },
    });
    const cursors = quill.getModule("cursors") as QuillCursors;
    // which replicaIds currently have a cursor built in the DOM, so move vs create can be told apart and a cursor only gets removed once its owner actually leaves
    const knownCursorIds = new Set<string>();

    // reconciles the remote presence entries against quill-cursors — creates a cursor for a new replica, removes one that left, and updates position/selection for the rest
    const syncCursors = () => {
      const { replicaId: ownReplicaId, presence } = client.getSnapshot();
      const activeIds = new Set(presence.map((entry) => entry.replicaId));

      for (const id of knownCursorIds) {
        if (!activeIds.has(id)) {
          cursors.removeCursor(id);
          knownCursorIds.delete(id);
        }
      }

      const docLength = quill.getLength();
      for (const entry of presence) {
        if (entry.replicaId === ownReplicaId) continue; // never show our own cursor
        const range = toQuillRange(entry.selection);
        if (!range) {
          if (knownCursorIds.has(entry.replicaId)) {
            cursors.removeCursor(entry.replicaId);
            knownCursorIds.delete(entry.replicaId);
          }
          continue;
        }
        // there can be a small race between a presence broadcast and the local doc state (they arrive via separate paths) — sending an out-of-bounds index can crash quill-cursors internally, so clamping is required
        const maxIndex = Math.max(0, docLength - 1);
        const index = Math.min(range.index, maxIndex);
        const length = Math.min(range.length, maxIndex - index);

        if (!knownCursorIds.has(entry.replicaId)) {
          cursors.createCursor(entry.replicaId, entry.name ?? "Anonymous", entry.color ?? "#999999");
          knownCursorIds.add(entry.replicaId);
        }
        cursors.moveCursor(entry.replicaId, { index, length });
      }
    };

    // "silent" so the initial load doesn't fire a text-change event — otherwise the content we just loaded would go straight back through applyLocalEdits
    quill.setContents(new Delta(client.getContentsForEditor()), "silent");

    const handleTextChange = (delta: QuillDelta, _oldDelta: unknown, source: string) => {
      // source is "api" when we call updateContents ourselves (remote sync) — only real user typing should continue past this point
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

    // fires whenever the client changes for any reason (remote op, presence, whatever) — diff it and only push what actually changed into Quill, so the cursor position survives
    const unsubscribe = client.subscribe(() => {
      const currentDelta = quill.getContents();
      const nextDelta = new Delta(client.getContentsForEditor());
      const diff = currentDelta.diff(nextDelta);
      if (diff.ops.length > 0) {
        quill.updateContents(diff, "silent");
      }
      syncCursors();
    });

    syncCursors();

    return () => {
      quill.off("text-change", handleTextChange);
      quill.off("selection-change", handleSelectionChange);
      unsubscribe();
      cursors.clearCursors();
      container.innerHTML = "";
    };
  }, [client]);

  return (
    <div className="border border-neutral-200 bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <div ref={containerRef} className="editor" />
    </div>
  );
}
