import { describe, expect, test } from "vitest";
import { deltaToEdits } from "./deltaToEdits";

// deltaToEdits has no Quill dependency, so these are plain unit tests against raw delta shapes
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

  test("insert with a boolean attribute carries it through as attrs", () => {
    expect(deltaToEdits({ ops: [{ insert: "a", attributes: { bold: true } }] })).toEqual([
      { kind: "insert", index: 0, value: "a", attrs: { bold: true } },
    ]);
  });

  test("insert with a non-boolean attribute (e.g. color) drops just that key", () => {
    expect(deltaToEdits({ ops: [{ insert: "a", attributes: { bold: true, color: "#f00" } }] })).toEqual([
      { kind: "insert", index: 0, value: "a", attrs: { bold: true } },
    ]);
  });

  test("insert with only non-boolean attributes carries no attrs at all", () => {
    expect(deltaToEdits({ ops: [{ insert: "a", attributes: { color: "#f00" } }] })).toEqual([
      { kind: "insert", index: 0, value: "a" },
    ]);
  });

  test("retain with attributes (toolbar format click on existing text) becomes a format edit", () => {
    expect(deltaToEdits({ ops: [{ retain: 2 }, { retain: 3, attributes: { bold: true } }] })).toEqual([
      { kind: "format", index: 2, length: 3, attrs: { bold: true } },
    ]);
  });

  test("retain with a false/null attribute becomes a format edit that clears the mark", () => {
    expect(deltaToEdits({ ops: [{ retain: 1, attributes: { bold: null } }] })).toEqual([
      { kind: "format", index: 0, length: 1, attrs: { bold: null } },
    ]);
  });

  test("plain retain (no attributes) advances the cursor without emitting an edit", () => {
    expect(deltaToEdits({ ops: [{ retain: 5 }] })).toEqual([]);
  });

  test("empty delta produces no edits", () => {
    expect(deltaToEdits({ ops: [] })).toEqual([]);
  });
});
