// Per-document monotonic seq assign karta hai, catch-up ke liye use hota hai. Yeh
// authority har server process ke liye common honi chahiye — agar har process apna
// local counter badhata toh "seq" ka matlab har process mein alag hota, aur global
// catch-up cursor ka poora fayda hi khatam ho jata. Production mein Redis (INCR)
// hi yeh shared authority hai; PubSubBus / PresenceStore mein bhi same
// in-memory-fake-for-tests pattern hai.
export interface SeqAllocator {
  next(docId: string): Promise<number>;
  current(docId: string): Promise<number>;
  close(): Promise<void>;
}
