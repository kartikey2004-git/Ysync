export interface PresenceEntry {
  replicaId: string;
  cursor?: number | null;
  selection?: { anchor: number; head: number } | null;
  name?: string;
  color?: string;
}

// Ephemeral awareness storage — never touches Postgres. TTL-based rather than tied to socket close, so if a connection dies without a clean disconnect, presence still cleans itself up.

// sweep is pull-based, the store doesn't run its own timer — the owning Room already runs a periodic tick (see room.ts) and calls sweep off of that, so one active document only has one clock running, and the store doesn't need to track docIds separately.
export interface PresenceStore {
  set(docId: string, entry: PresenceEntry, ttlMs: number): Promise<void>;
  remove(docId: string, replicaId: string): Promise<void>;
  list(docId: string): Promise<PresenceEntry[]>;
  // removes entries past their TTL for docId; returns the replicaIds that expired
  sweep(docId: string): Promise<string[]>;
  close(): Promise<void>;
}
