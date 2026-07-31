export interface PresenceEntry {
  replicaId: string;
  cursor?: number | null;
  selection?: { anchor: number; head: number } | null;
  name?: string;
  color?: string;
}

/**
 * Ephemeral awareness storage (system-design.md §6.5) — never touches
 * Postgres. TTL-based rather than tied to socket close, so presence also
 * clears out if a connection dies without a clean disconnect.
 *
 * `sweep` is pull-based rather than the store running its own timers: the
 * owning `Room` already runs a periodic tick (see room.ts) and calls
 * `sweep` on it, so there's one clock per active document instead of the
 * store needing to track which docIds exist.
 */
export interface PresenceStore {
  set(docId: string, entry: PresenceEntry, ttlMs: number): Promise<void>;
  remove(docId: string, replicaId: string): Promise<void>;
  list(docId: string): Promise<PresenceEntry[]>;
  /** Removes entries past their TTL for `docId`; returns the replicaIds that expired. */
  sweep(docId: string): Promise<string[]>;
  close(): Promise<void>;
}
