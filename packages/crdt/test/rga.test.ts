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

    // deliberately delivering these out of causal order
    bob.apply(second);
    expect(bob.read()).toEqual(""); // origin hasn't arrived yet, so this sits in the buffer
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

    // bob and carol both insert after "q" concurrently
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

describe("formatting", () => {
  test("localInsert with attrs shows up as an attributed run, and read() still returns plain text", () => {
    const rga = new Rga();
    rga.localInsert(0, "a");
    rga.localInsert(1, "b", { bold: true });
    rga.localInsert(2, "c");

    expect(rga.read()).toEqual("abc");
    expect(rga.getContentsForEditor()).toEqual([
      { insert: "a" },
      { insert: "b", attributes: { bold: true } },
      { insert: "c" },
      { insert: "\n" },
    ]);
  });

  test("localFormat retroactively marks existing plain text without changing read()", () => {
    const rga = new Rga();
    rga.localInsert(0, "a");
    rga.localInsert(1, "b");
    rga.localInsert(2, "c");

    rga.localFormat(1, 1, { bold: true });

    expect(rga.read()).toEqual("abc");
    expect(rga.getContentsForEditor()).toEqual([
      { insert: "a" },
      { insert: "b", attributes: { bold: true } },
      { insert: "c" },
      { insert: "\n" },
    ]);
  });

  test("localFormat with a null patch value removes an existing mark", () => {
    const rga = new Rga();
    rga.localInsert(0, "a", { bold: true });
    rga.localFormat(0, 1, { bold: null });

    expect(rga.getContentsForEditor()).toEqual([{ insert: "a" }, { insert: "\n" }]);
  });

  test("localFormat merges with existing marks instead of replacing them", () => {
    const rga = new Rga();
    rga.localInsert(0, "a", { bold: true });
    rga.localFormat(0, 1, { italic: true });

    expect(rga.getContentsForEditor()).toEqual([
      { insert: "a", attributes: { bold: true, italic: true } },
      { insert: "\n" },
    ]);
  });

  test("localFormat spanning multiple characters formats all of them and leaves the rest untouched", () => {
    const rga = new Rga();
    for (const [i, ch] of [..."hello"].entries()) rga.localInsert(i, ch);

    rga.localFormat(1, 3, { bold: true }); // "ell"

    expect(rga.read()).toEqual("hello");
    expect(rga.getContentsForEditor()).toEqual([
      { insert: "h" },
      { insert: "ell", attributes: { bold: true } },
      { insert: "o" },
      { insert: "\n" },
    ]);
  });

  test("apply() replays format ops from a remote replica and converges", () => {
    const alice = new Rga("alice");
    alice.localInsert(0, "a");
    alice.localInsert(1, "b");
    alice.localInsert(2, "c");

    const bob = Rga.fromSnapshot(alice.toSnapshot(), "bob");

    const formatOps = alice.localFormat(1, 1, { bold: true });
    bob.applyAll(formatOps);

    expect(bob.read()).toEqual(alice.read());
    expect(bob.getContentsForEditor()).toEqual(alice.getContentsForEditor());
  });

  test("concurrent formatting of overlapping ranges from two replicas converges without duplicating characters", () => {
    const alice = new Rga("alice");
    alice.localInsert(0, "a");
    alice.localInsert(1, "b");
    alice.localInsert(2, "c");

    const bob = Rga.fromSnapshot(alice.toSnapshot(), "bob");

    const aliceOps = alice.localFormat(0, 2, { bold: true }); // "ab"
    const bobOps = bob.localFormat(1, 2, { italic: true }); // "bc"

    alice.applyAll(bobOps);
    bob.applyAll(aliceOps);

    // the overlapping character "b" picks up both marks — it must NOT become two characters
    expect(alice.read()).toEqual("abc");
    expect(bob.read()).toEqual(alice.read());
    expect(bob.getContentsForEditor()).toEqual(alice.getContentsForEditor());
    expect(alice.getContentsForEditor()).toEqual([
      { insert: "a", attributes: { bold: true } },
      { insert: "b", attributes: { bold: true, italic: true } },
      { insert: "c", attributes: { italic: true } },
      { insert: "\n" },
    ]);
  });

  test("concurrent format ops on the same mark of the same character converge to one winner (LWW by op id)", () => {
    const alice = new Rga("alice");
    alice.localInsert(0, "a");

    const bob = Rga.fromSnapshot(alice.toSnapshot(), "bob");

    // both replicas race to decide "bold" for the same character, one setting it, one clearing it
    const aliceOps = alice.localFormat(0, 1, { bold: true });
    const bobOps = bob.localFormat(0, 1, { bold: null });

    alice.applyAll(bobOps);
    bob.applyAll(aliceOps);

    expect(bob.getContentsForEditor()).toEqual(alice.getContentsForEditor());
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
    rga.localDelete(1); // tombstone "b"

    rga.compactTombstones();
    expect(rga.read()).toEqual("ac");

    // a new insert anchored after the (now compacted) tombstone should still land in the right place
    rga.localInsert(1, "x");
    expect(rga.read()).toEqual("axc");
  });
});
