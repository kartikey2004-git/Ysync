"use client";

import type { CSSProperties } from "react";
import type { ConnectionState, DocumentClientSnapshot } from "@/lib/documentClient";

interface PresenceListProps {
  snapshot: DocumentClientSnapshot;
}

const STATE_LABEL: Record<ConnectionState, string> = {
  open: "Live",
  connecting: "Connecting",
  closed: "Offline",
};

const STATE_CLASSES: Record<ConnectionState, string> = {
  open: "border-black text-black",
  connecting: "border-neutral-300 text-neutral-500",
  closed: "border-neutral-300 text-neutral-400",
};

const DOT_CLASSES: Record<ConnectionState, string> = {
  open: "bg-black",
  connecting: "animate-pulse bg-neutral-400",
  closed: "bg-neutral-300",
};

function dotStyle(color: string): CSSProperties {
  return { backgroundColor: color };
}

export function PresenceList({ snapshot }: PresenceListProps) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {snapshot.name && (
          <span className="inline-flex items-center gap-1.5 border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700">
            <span className="h-2 w-2 shrink-0" style={dotStyle(snapshot.color)} />
            {snapshot.name} <span className="text-neutral-400">(you)</span>
          </span>
        )}
        {snapshot.presence.map((entry) => (
          <span
            key={entry.replicaId}
            className="inline-flex items-center gap-1.5 border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700"
          >
            <span className="h-2 w-2 shrink-0" style={dotStyle(entry.color ?? "#999999")} />
            {entry.name ?? "Anonymous"}
          </span>
        ))}
      </div>

      <span
        className={`inline-flex items-center gap-1.5 border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wider ${STATE_CLASSES[snapshot.connectionState]}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${DOT_CLASSES[snapshot.connectionState]}`} />
        {STATE_LABEL[snapshot.connectionState]}
      </span>
    </div>
  );
}
