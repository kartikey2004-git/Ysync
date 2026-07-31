"use client";

import type { CSSProperties } from "react";
import type { DocumentClientSnapshot } from "@/lib/documentClient";

interface PresenceListProps {
  snapshot: DocumentClientSnapshot;
}

function dotStyle(color: string): CSSProperties {
  return { backgroundColor: color };
}

export function PresenceList({ snapshot }: PresenceListProps) {
  return (
    <div className="presence-list">
      {snapshot.name && (
        <span className="presence-entry">
          <span className="dot" style={dotStyle(snapshot.color)} />
          {snapshot.name} (you)
        </span>
      )}
      {snapshot.presence.map((entry) => (
        <span key={entry.replicaId} className="presence-entry">
          <span className="dot" style={dotStyle(entry.color ?? "#999999")} />
          {entry.name ?? "Anonymous"}
        </span>
      ))}
      <span className={`connection-state connection-state--${snapshot.connectionState}`}>
        {snapshot.connectionState}
      </span>
    </div>
  );
}
