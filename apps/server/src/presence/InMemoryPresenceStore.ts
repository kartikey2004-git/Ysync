import type { PresenceEntry, PresenceStore } from "./PresenceStore.js";

interface StoredEntry {
  entry: PresenceEntry;
  expiresAt: number;
}

// RedisPresenceStore ka in-memory version hai, same contract follow karta hai —
// tests aur loadtest script isko use karte hain taaki real Redis chalane ki zaroorat na pade.
export class InMemoryPresenceStore implements PresenceStore {
  private readonly docs = new Map<string, Map<string, StoredEntry>>();

  async set(docId: string, entry: PresenceEntry, ttlMs: number): Promise<void> {
    let byReplica = this.docs.get(docId);
    if (!byReplica) {
      byReplica = new Map();
      this.docs.set(docId, byReplica);
    }
    byReplica.set(entry.replicaId, { entry, expiresAt: Date.now() + ttlMs });
  }

  async remove(docId: string, replicaId: string): Promise<void> {
    this.docs.get(docId)?.delete(replicaId);
  }

  async list(docId: string): Promise<PresenceEntry[]> {
    const byReplica = this.docs.get(docId);
    if (!byReplica) return [];
    const now = Date.now();
    // yahan sirf filter kar rahe hain, delete nahi — actual cleanup sweep() ka kaam hai
    return [...byReplica.values()].filter((stored) => stored.expiresAt > now).map((stored) => stored.entry);
  }

  async sweep(docId: string): Promise<string[]> {
    const byReplica = this.docs.get(docId);
    if (!byReplica) return [];
    const now = Date.now();
    const expired: string[] = [];
    for (const [replicaId, stored] of byReplica) {
      if (stored.expiresAt <= now) {
        expired.push(replicaId);
        byReplica.delete(replicaId);
      }
    }
    return expired;
  }

  async close(): Promise<void> {
    this.docs.clear();
  }
}
