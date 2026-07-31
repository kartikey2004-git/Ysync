/**
 * Assigns the monotonic per-document `seq` used for catch-up (system-design.md
 * §5, §6.1). This must be a single shared authority across every server
 * process for a given document — if each process incremented its own local
 * counter, "seq" would mean different things depending on which process
 * handled a given op, defeating its purpose as a global catch-up cursor.
 * Redis (`INCR`) is that shared authority in production; see PubSubBus /
 * PresenceStore for the same in-memory-fake-for-tests pattern.
 */
export interface SeqAllocator {
  next(docId: string): Promise<number>;
  current(docId: string): Promise<number>;
  close(): Promise<void>;
}
