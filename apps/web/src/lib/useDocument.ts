"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { DocumentClient, EMPTY_SNAPSHOT, type DocumentClientSnapshot } from "./documentClient";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

export interface UseDocumentResult {
  client: DocumentClient | null;
  snapshot: DocumentClientSnapshot;
}

export function useDocument(docId: string, userId: string | null): UseDocumentResult {
  const [client, setClient] = useState<DocumentClient | null>(null);

  useEffect(() => {
    if (!userId) return;
    const instance = new DocumentClient(docId, WS_URL, userId);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(instance);

    return () => {
      instance.dispose();
      setClient(null);
    };
  }, [docId, userId]);

  const snapshot = useSyncExternalStore(
    (onStoreChange) => (client ? client.subscribe(onStoreChange) : () => {}),
    () => client?.getSnapshot() ?? EMPTY_SNAPSHOT,
    () => EMPTY_SNAPSHOT,
  );

  return { client, snapshot };
}
