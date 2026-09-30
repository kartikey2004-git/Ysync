import type { SeqAllocator } from "./SeqAllocator.js";

export interface InMemorySeqAllocatorOptions {
  getLatestSeq?: (docId: string) => Promise<number>;
}

// a shared counter that multiple InMemorySeqAllocators can point at to simulate one Redis
export class InMemorySeqCounter {
  private readonly counters = new Map<string, number>();

  next(docId: string): number {
    const value = (this.counters.get(docId) ?? 0) + 1;
    this.counters.set(docId, value);
    return value;
  }

  current(docId: string): number {
    return this.counters.get(docId) ?? 0;
  }

  // Simulates Redis restart — clears the counter for seeding tests
  reset(docId: string): void {
    this.counters.delete(docId);
  }

  // Atomic seed: if current < floor, set to floor+1 and return floor+1.
  // Otherwise increment normally. Mirrors the Lua script in RedisSeqAllocator.
  seedAndNext(docId: string, floor: number): number {
    const current = this.counters.get(docId) ?? 0;
    if (current <= floor) {
      const next = floor + 1;
      this.counters.set(docId, next);
      return next;
    }
    return this.next(docId);
  }
}

export class InMemorySeqAllocator implements SeqAllocator {
  private readonly counter: InMemorySeqCounter;
  private readonly getLatestSeq?: (docId: string) => Promise<number>;

  constructor(counter?: InMemorySeqCounter, options?: InMemorySeqAllocatorOptions) {
    this.counter = counter ?? new InMemorySeqCounter();
    this.getLatestSeq = options?.getLatestSeq;
  }

  async next(docId: string): Promise<number> {
    const seq = this.counter.next(docId);

    if (seq !== 1 || !this.getLatestSeq) return seq;

    let dbLatestSeq: number;
    try {
      dbLatestSeq = await this.getLatestSeq(docId);
    } catch {
      return seq;
    }

    if (dbLatestSeq <= 0) return seq;

    return this.counter.seedAndNext(docId, dbLatestSeq);
  }

  async current(docId: string): Promise<number> {
    return this.counter.current(docId);
  }

  async close(): Promise<void> {
    // nothing to release here, this only exists to satisfy the interface
  }
}
