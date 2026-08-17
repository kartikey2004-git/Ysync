export interface PresenceEntry {
  replicaId: string;
  cursor?: number | null;
  selection?: { anchor: number; head: number } | null;
  name?: string;
  color?: string;
}

// Ephemeral awareness storage hai — Postgres ko kabhi touch nahi karta. TTL-based
// hai, socket close se bandha nahi hai, isliye agar connection bina clean
// disconnect ke mar jaaye toh bhi presence apne aap saaf ho jayegi.
//
// sweep pull-based hai, store apna timer nahi chalata — owning Room pehle se
// periodic tick chala raha hai (room.ts dekho) aur usi pe sweep call karta hai,
// isliye ek active document pe ek hi clock chalta hai, store ko alag se
// docIds track karne ki zaroorat nahi.
export interface PresenceStore {
  set(docId: string, entry: PresenceEntry, ttlMs: number): Promise<void>;
  remove(docId: string, replicaId: string): Promise<void>;
  list(docId: string): Promise<PresenceEntry[]>;
  // docId ke liye TTL cross kar chuke entries hata deta hai; jo replicaIds expire hue unhe return karta hai
  sweep(docId: string): Promise<string[]>;
  close(): Promise<void>;
}
