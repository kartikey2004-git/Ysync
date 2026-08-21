"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { DocumentClient, EMPTY_SNAPSHOT, type DocumentClientSnapshot } from "./documentClient";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

export interface UseDocumentResult {
  client: DocumentClient | null;
  snapshot: DocumentClientSnapshot;
}

// React binding for DocumentClient. The client is browser-only (WebSocket +
// IndexedDB), so it's built inside an effect — never in the render body, even guarded
// by typeof window — so the client's first (pre-hydration) render exactly matches the
// server's null. Building it eagerly during render caused a real hydration mismatch
// (the server renders the null branch, but the client's first pass already had a
// non-null client) — this bug only showed up running the app in a browser, a build pass wouldn't catch it.
export function useDocument(docId: string): UseDocumentResult {
  const [client, setClient] = useState<DocumentClient | null>(null);

  useEffect(() => {
    const instance = new DocumentClient(docId, WS_URL);
    // this setState has to stay inside the effect — the instance can't be built in the render body (reason above)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(instance);

    // close the old WS connection when docId changes or the component unmounts, don't leak it
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
