"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { DocumentClient, EMPTY_SNAPSHOT, type DocumentClientSnapshot } from "./documentClient";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

export interface UseDocumentResult {
  client: DocumentClient | null;
  snapshot: DocumentClientSnapshot;
}

// DocumentClient ke liye React binding hai. Client browser-only hai (WebSocket +
// IndexedDB), isliye isko effect ke andar banate hain — render body mein kabhi
// nahi, chahe typeof window se guard bhi kar lo — taaki client ka pehla
// (pre-hydration) render server ke null se exactly match kare. Render ke
// dauraan eagerly banane se real hydration mismatch aaya tha (server null
// branch render karta hai, client ke pehle pass mein already non-null client
// tha) — yeh bug sirf browser mein app chala ke pakda gaya tha, build pass
// hone se pata hi nahi chalta.
export function useDocument(docId: string): UseDocumentResult {
  const [client, setClient] = useState<DocumentClient | null>(null);

  useEffect(() => {
    const instance = new DocumentClient(docId, WS_URL);
    // yeh setState effect ke andar hi hona chahiye — instance render body mein bana hi nahi sakte (upar wajah likhi hai)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClient(instance);

    // docId badalne ya component unmount hone pe purana WS connection band karo, leak nahi hone dena
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
