import { describe, expect, test } from "vitest";
import { deltaToEdits } from "./deltaToEdits";

describe("deltaToEdits", () => {
  test("plain insert at the start", () => {
    expect(deltaToEdits({ ops: [{ insert: "abc" }] })).toEqual([
      { kind: "insert", index: 0, value: "a" },
      { kind: "insert", index: 1, value: "b" },
      { kind: "insert", index: 2, value: "c" },
    ]);
  });

  test("insert after a retain", () => {
    expect(deltaToEdits({ ops: [{ retain: 3 }, { insert: "xy" }] })).toEqual([
      { kind: "insert", index: 3, value: "x" },
      { kind: "insert", index: 4, value: "y" },
    ]);
  });

  test("delete after a retain — index never advances (each delete collapses the position)", () => {
    expect(deltaToEdits({ ops: [{ retain: 2 }, { delete: 3 }] })).toEqual([
      { kind: "delete", index: 2 },
      { kind: "delete", index: 2 },
      { kind: "delete", index: 2 },
    ]);
  });

  test("replace: retain, delete, then insert", () => {
    expect(deltaToEdits({ ops: [{ retain: 1 }, { delete: 2 }, { insert: "Z" }] })).toEqual([
      { kind: "delete", index: 1 },
      { kind: "delete", index: 1 },
      { kind: "insert", index: 1, value: "Z" },
    ]);
  });

  test("embedded (non-string) inserts are skipped but still occupy a position", () => {
    expect(deltaToEdits({ ops: [{ insert: { image: "foo.png" } }, { insert: "a" }] })).toEqual([
      { kind: "insert", index: 1, value: "a" },
    ]);
  });

  test("rich-text attributes are dropped — plain text only for this phase", () => {
    expect(deltaToEdits({ ops: [{ insert: "a", attributes: { bold: true } }] })).toEqual([
      { kind: "insert", index: 0, value: "a" },
    ]);
  });

  test("empty delta produces no edits", () => {
    expect(deltaToEdits({ ops: [] })).toEqual([]);
  });
});
