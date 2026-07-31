"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { DocumentClient, EMPTY_SNAPSHOT, type DocumentClientSnapshot } from "./documentClient";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

export interface UseDocumentResult {
  client: DocumentClient | null;
  snapshot: DocumentClientSnapshot;
}

/**
 * React binding for a `DocumentClient` (system-design.md §8.1). The client
 * is browser-only (WebSocket + IndexedDB), so it's constructed in an
 * effect — never directly in the render body, even guarded by
 * `typeof window` — so the client's first (pre-hydration) render matches
 * the server's `null` exactly. Constructing it eagerly during render
 * caused a real hydration mismatch (server renders the `null` branch,
 * client's first pass already had a non-null client) — caught by actually
 * running the app in a browser, not just by the build succeeding.
 */
export function useDocument(docId: string): UseDocumentResult {
  const [client, setClient] = useState<DocumentClient | null>(null);

  useEffect(() => {
    const instance = new DocumentClient(docId, WS_URL);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(instance);

    return () => {
      instance.dispose();
      setClient(null);
    };
  }, [docId]);

  const snapshot = useSyncExternalStore(
    (onStoreChange) => (client ? client.subscribe(onStoreChange) : () => {}),
    () => client?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => EMPTY_SNAPSHOT,
  );

  return { client, snapshot };
}
