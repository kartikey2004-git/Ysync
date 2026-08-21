// Assigns a per-document monotonic seq, used for catch-up. This authority has to be shared across every server process — if each process incremented its own local counter, "seq" would mean something different per process and the whole point of a global catch-up cursor would be lost. In production Redis (INCR) is that shared authority; same in-memory-fake-for-tests pattern as PubSubBus / PresenceStore.
export interface SeqAllocator {
  next(docId: string): Promise<number>;
  current(docId: string): Promise<number>;
  close(): Promise<void>;
}
