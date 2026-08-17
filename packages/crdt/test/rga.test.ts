import { describe, expect, test } from "vitest";
import { Rga } from "../src/rga.js";

describe("create", () => {
  test("a fresh Rga reads as empty", () => {
    const rga = new Rga();
    expect(rga.read()).toEqual("");
  });
});

describe("insert", () => {
  test("inserting an element at head", () => {
    const rga = new Rga();
    rga.localInsert(0, "c");
    expect(rga.read()).toEqual("c");
  });

  test("inserting an element after head", () => {
    const rga = new Rga();
    rga.localInsert(0, "a");
    rga.localInsert(1, "c");
    expect(rga.read()).toEqual("ac");
  });

  test("inserting multiple elements after head", () => {
    const rga = new Rga();
    rga.localInsert(0, "w");
    rga.localInsert(1, "q");
    rga.localInsert(1, "b");
    expect(rga.read()).toEqual("wbq");
  });
});

describe("delete", () => {
  test("delete element at head", () => {
    const rga = new Rga();
    rga.localInsert(0, "q");
    rga.localInsert(1, "b");
    rga.localDelete(0);
    expect(rga.read()).toEqual("b");
  });

  test("delete element after head", () => {
    const rga = new Rga();
    rga.localInsert(0, "w");
    rga.localInsert(1, "q");
    rga.localInsert(2, "b");
    rga.localDelete(1);
    expect(rga.read()).toEqual("wb");
  });
});

describe("mixed operations", () => {
  test("add one element after one deletion", () => {
    const rga = new Rga();
    rga.localInsert(0, "q");
    rga.localInsert(1, "b");
    rga.localDelete(1);
    rga.localInsert(1, "c");
    expect(rga.read()).toEqual("qc");
  });

  test("add multiple elements after deletion", () => {
    const rga = new Rga();
    rga.localInsert(0, "q");
    rga.localInsert(1, "b");
    rga.localInsert(2, "c");
    rga.localDelete(2);
    rga.localInsert(2, "d");
    rga.localInsert(3, "e");
    rga.localInsert(4, "f");
    expect(rga.read()).toEqual("qbdef");
  });

  test("add multiple elements after multiple deletions", () => {
    const rga = new Rga();
    rga.localInsert(0, "q"); // q
    rga.localInsert(1, "b"); // qb
    rga.localInsert(2, "c"); // qbc
    rga.localDelete(2); // qb
    rga.localInsert(2, "d"); // qbd
    rga.localInsert(3, "e"); // qbde
    rga.localDelete(2); // qbe
    rga.localDelete(2); // qb
    rga.localInsert(2, "f"); // qbf
    rga.localInsert(3, "g"); // qbfg
    rga.localInsert(0, "h"); // hqbfg
    expect(rga.read()).toEqual("hqbfg");
  });
});

describe("replication", () => {
  test("apply() replays a remote replica's ops and converges", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");

    const ops = [
      alice.localInsert(0, "h"),
      alice.localInsert(1, "i"),
    ];
    bob.applyAll(ops);

    expect(bob.read()).toEqual(alice.read());
  });

  test("apply() is idempotent — replaying the same op twice is a no-op", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");
    const op = alice.localInsert(0, "x");

    bob.apply(op);
    bob.apply(op);

    expect(bob.read()).toEqual("x");
  });

  test("apply() buffers an insert until its origin arrives, then integrates it", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");

    const first = alice.localInsert(0, "a");
    const second = alice.localInsert(1, "b");

    // jaan-boojh kar causal order todh ke bhej rahe hain
    bob.apply(second);
    expect(bob.read()).toEqual(""); // origin abhi tak nahi aaya, isliye buffer mein pada hai
    bob.apply(first);
    expect(bob.read()).toEqual("ab");
  });

  test("apply() buffers a delete until its target arrives", () => {
    const alice = new Rga("alice");
    const bob = new Rga("bob");

    const insertOp = alice.localInsert(0, "z");
    const deleteOp = alice.localDelete(0);

    bob.apply(deleteOp);
    expect(bob.read()).toEqual("");
    bob.apply(insertOp);
    expect(bob.read()).toEqual("");
  });

  test("concurrent inserts at the same anchor converge to the same order on every replica", () => {
    const alice = new Rga("alice");
    alice.localInsert(0, "q");

    const bob = Rga.fromSnapshot(alice.toSnapshot(), "bob");
    const carol = Rga.fromSnapshot(alice.toSnapshot(), "carol");

    // bob aur carol dono concurrently "q" ke baad insert kar rahe hain
    const bobOp = bob.localInsert(1, "b");
    const carolOp = carol.localInsert(1, "c");

    alice.apply(bobOp);
    alice.apply(carolOp);
    bob.apply(carolOp);
    carol.apply(bobOp);

    expect(bob.read()).toEqual(alice.read());
    expect(carol.read()).toEqual(alice.read());
  });
});

describe("snapshot + tombstone compaction", () => {
  test("toSnapshot/fromSnapshot round-trips the document", () => {
    const rga = new Rga();
    rga.localInsert(0, "a");
    rga.localInsert(1, "b");
    rga.localDelete(0);

    const restored = Rga.fromSnapshot(rga.toSnapshot());
    expect(restored.read()).toEqual(rga.read());
  });

  test("compacting tombstones preserves read() and future insertion position", () => {
    const rga = new Rga();
    rga.localInsert(0, "a");
    rga.localInsert(1, "b");
    rga.localInsert(2, "c");
    rga.localDelete(1); // "b" ko tombstone kar do

    rga.compactTombstones();
    expect(rga.read()).toEqual("ac");

    // ab (compacted) tombstone ke baad koi naya insert anchor ho toh bhi
    // sahi jagah pe hi lagna chahiye
    rga.localInsert(1, "x");
    expect(rga.read()).toEqual("axc");
  });
});
