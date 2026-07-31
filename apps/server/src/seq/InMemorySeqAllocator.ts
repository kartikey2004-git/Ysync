import type { SeqAllocator } from "./SeqAllocator.js";

/** Shared counter multiple `InMemorySeqAllocator`s can point at to simulate one Redis. */
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
}

export class InMemorySeqAllocator implements SeqAllocator {
  private readonly counter: InMemorySeqCounter;

  constructor(counter: InMemorySeqCounter = new InMemorySeqCounter()) {
    this.counter = counter;
  }

  async next(docId: string): Promise<number> {
    return this.counter.next(docId);
  }

  async current(docId: string): Promise<number> {
    return this.counter.current(docId);
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
