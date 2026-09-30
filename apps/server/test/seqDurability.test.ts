import { describe, expect, test } from "vitest";
import { InMemorySeqAllocator, InMemorySeqCounter } from "../src/seq/InMemorySeqAllocator.js";

describe("Sequence durability (seeding from DB)", () => {
  test("fresh counter with no DB data returns 1", async () => {
    const alloc = new InMemorySeqAllocator(new InMemorySeqCounter(), {
      getLatestSeq: async () => 0,
    });
    expect(await alloc.next("doc-1")).toBe(1);
  });

  test("fresh counter seeds from DB when DB has higher seq", async () => {
    const alloc = new InMemorySeqAllocator(new InMemorySeqCounter(), {
      getLatestSeq: async () => 100,
    });
    const seq = await alloc.next("doc-1");
    expect(seq).toBe(101);
  });

  test("subsequent allocations increment beyond the seeded value", async () => {
    const alloc = new InMemorySeqAllocator(new InMemorySeqCounter(), {
      getLatestSeq: async () => 50,
    });
    const first = await alloc.next("doc-1");
    expect(first).toBe(51);
    const second = await alloc.next("doc-1");
    expect(second).toBe(52);
    const third = await alloc.next("doc-1");
    expect(third).toBe(53);
  });

  test("simulated Redis restart re-seeds from DB", async () => {
    const counter = new InMemorySeqCounter();
    let dbLatestSeq = 0;
    const alloc = new InMemorySeqAllocator(counter, {
      getLatestSeq: async () => dbLatestSeq,
    });

    const s1 = await alloc.next("doc-1");
    expect(s1).toBe(1);
    const s2 = await alloc.next("doc-1");
    expect(s2).toBe(2);

    dbLatestSeq = 2;
    counter.reset("doc-1");

    const s3 = await alloc.next("doc-1");
    expect(s3).toBe(3);
  });

  test("getLatestSeq failure falls back to raw INCR value", async () => {
    const alloc = new InMemorySeqAllocator(new InMemorySeqCounter(), {
      getLatestSeq: async () => {
        throw new Error("DB unavailable");
      },
    });
    const seq = await alloc.next("doc-1");
    expect(seq).toBe(1);
  });

  test("concurrent initialization from multiple allocators produces unique seqs", async () => {
    const counter = new InMemorySeqCounter();
    const getLatestSeq = async () => 100;

    const alloc1 = new InMemorySeqAllocator(counter, { getLatestSeq });
    const alloc2 = new InMemorySeqAllocator(counter, { getLatestSeq });

    const [seq1, seq2] = await Promise.all([
      alloc1.next("doc-1"),
      alloc2.next("doc-1"),
    ]);

    expect(new Set([seq1, seq2]).size).toBe(2);

    // After both complete, subsequent allocations must be above the DB floor.
    // The first caller that got seq===1 triggers seeding and bumps the counter.
    // The second caller may get a low seq (2) before the seed — that's OK:
    // PostgreSQL's GREATEST clause in appendOps prevents latestSeq regression.
    const seq3 = await alloc1.next("doc-1");
    expect(seq3).toBeGreaterThan(100);
  });

  test("sequence monotonicity across simulated process restarts", async () => {
    const counter = new InMemorySeqCounter();
    let dbLatestSeq = 0;
    const makeAllocator = () =>
      new InMemorySeqAllocator(counter, {
        getLatestSeq: async () => dbLatestSeq,
      });

    const alloc1 = makeAllocator();
    const s1 = await alloc1.next("doc-1");
    const s2 = await alloc1.next("doc-1");
    dbLatestSeq = s2;
    await alloc1.close();

    counter.reset("doc-1");

    const alloc2 = makeAllocator();
    const s3 = await alloc2.next("doc-1");
    expect(s3).toBeGreaterThan(s2);

    const s4 = await alloc2.next("doc-1");
    expect(s4).toBeGreaterThan(s3);
    await alloc2.close();
  });

  test("allocator without getLatestSeq never seeds", async () => {
    const counter = new InMemorySeqCounter();
    const alloc = new InMemorySeqAllocator(counter);
    expect(await alloc.next("doc-1")).toBe(1);
    expect(await alloc.next("doc-1")).toBe(2);
  });

  test("per-document isolation: different docs seed independently", async () => {
    const counter = new InMemorySeqCounter();
    const alloc = new InMemorySeqAllocator(counter, {
      getLatestSeq: async (docId) => (docId === "doc-A" ? 50 : 200),
    });

    const a = await alloc.next("doc-A");
    const b = await alloc.next("doc-B");
    expect(a).toBe(51);
    expect(b).toBe(201);
  });
});
