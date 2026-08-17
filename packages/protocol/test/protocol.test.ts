import { describe, expect, test } from "vitest";
import { Rga } from "@ysync/crdt";
import {
  ackMessageSchema,
  broadcastOpMessageSchema,
  clientMessageSchema,
  errorMessageSchema,
  joinMessageSchema,
  leaveMessageSchema,
  opMessageSchema,
  opSchema,
  presenceLeaveMessageSchema,
  presenceMessageSchema,
  presenceUpdateMessageSchema,
  serverMessageSchema,
  snapshotMessageSchema,
  syncMessageSchema,
} from "../src/index.js";
import { parseClientMessage, parseServerMessage } from "../src/parse.js";
import type { ClientMessage, ServerMessage } from "../src/index.js";

// message wire pe jo JSON round-trip actually leta hai, wahi simulate karta hai
function overTheWire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

const opId = { counter: 1, replicaId: "alice" };

describe("client message round-trips", () => {
  const samples: ClientMessage[] = [
    { type: "join", docId: "doc-1", replicaId: "alice", sinceSeq: 0 },
    {
      type: "op",
      docId: "doc-1",
      ops: [
        { type: "insert", id: opId, originId: null, value: "h", attrs: { bold: true } },
        { type: "delete", targetId: opId },
      ],
    },
    {
      type: "presence",
      docId: "doc-1",
      cursor: 3,
      selection: { anchor: 1, head: 3 },
      name: "Alice",
      color: "#ff0000",
    },
    { type: "presence", docId: "doc-1" }, // awareness ke saare fields optional hain
    { type: "leave", docId: "doc-1" },
  ];

  test.each(samples)("round-trips %j", (message) => {
    const result = parseClientMessage(overTheWire(message));
    expect(result).toEqual({ success: true, data: message });
  });

  test("clientMessageSchema accepts the same samples directly", () => {
    for (const message of samples) {
      expect(clientMessageSchema.safeParse(overTheWire(message)).success).toBe(true);
    }
  });
});

describe("server message round-trips", () => {
  const samples: ServerMessage[] = [
    { type: "snapshot", docId: "doc-1", seq: 5, state: [{ id: opId, originId: null, value: "h", tombstone: false }] },
    { type: "sync", docId: "doc-1", seq: 5, ops: [{ type: "insert", id: opId, originId: null, value: "h" }] },
    { type: "ack", docId: "doc-1", seq: 5, opIds: [opId] },
    { type: "broadcast-op", docId: "doc-1", seq: 6, ops: [{ type: "delete", targetId: opId }] },
    { type: "presence-update", docId: "doc-1", replicaId: "bob", cursor: 2, name: "Bob" },
    { type: "presence-leave", docId: "doc-1", replicaId: "bob" },
    { type: "error", code: "INVALID_OP", message: "bad op" },
  ];

  test.each(samples)("round-trips %j", (message) => {
    const result = parseServerMessage(overTheWire(message));
    expect(result).toEqual({ success: true, data: message });
  });
});

describe("rejects malformed input", () => {
  test("missing required field", () => {
    const result = parseClientMessage({ type: "join", docId: "doc-1" }); // replicaId/sinceSeq missing hai
    expect(result.success).toBe(false);
  });

  test("wrong type literal", () => {
    const result = parseClientMessage({ type: "not-a-real-type", docId: "doc-1" });
    expect(result.success).toBe(false);
  });

  test("op with wrong shape is rejected", () => {
    expect(opSchema.safeParse({ type: "insert", id: opId }).success).toBe(false); // value missing hai
  });

  test("non-object input", () => {
    expect(parseClientMessage("just a string").success).toBe(false);
    expect(parseServerMessage(null).success).toBe(false);
  });

  test("individual message schemas reject cross-contaminated fields missing", () => {
    expect(joinMessageSchema.safeParse({ type: "join", docId: "d" }).success).toBe(false);
    expect(opMessageSchema.safeParse({ type: "op", docId: "d", ops: [] }).success).toBe(false); // ops khali nahi ho sakta
    expect(presenceMessageSchema.safeParse({ type: "presence" }).success).toBe(false); // docId missing hai
    expect(leaveMessageSchema.safeParse({ type: "leave" }).success).toBe(false);
    expect(snapshotMessageSchema.safeParse({ type: "snapshot", docId: "d", seq: 0 }).success).toBe(false);
    expect(syncMessageSchema.safeParse({ type: "sync", docId: "d" }).success).toBe(false);
    expect(ackMessageSchema.safeParse({ type: "ack", docId: "d", seq: 0 }).success).toBe(false);
    expect(broadcastOpMessageSchema.safeParse({ type: "broadcast-op", docId: "d" }).success).toBe(false);
    expect(presenceUpdateMessageSchema.safeParse({ type: "presence-update", docId: "d" }).success).toBe(false);
    expect(presenceLeaveMessageSchema.safeParse({ type: "presence-leave", docId: "d" }).success).toBe(false);
    expect(errorMessageSchema.safeParse({ type: "error", code: "X" }).success).toBe(false);
  });
});

describe("cross-package sanity check against @ysync/crdt", () => {
  test("real Ops produced by Rga validate against opSchema", () => {
    const rga = new Rga("alice");
    const insertOp = rga.localInsert(0, "h");
    const deleteOp = rga.localDelete(0);

    expect(opSchema.safeParse(overTheWire(insertOp)).success).toBe(true);
    expect(opSchema.safeParse(overTheWire(deleteOp)).success).toBe(true);
  });

  test("a full op message wrapping real Ops round-trips", () => {
    const rga = new Rga("alice");
    const ops = [rga.localInsert(0, "h"), rga.localInsert(1, "i")];
    const message: ClientMessage = { type: "op", docId: "doc-1", ops };

    const result = parseClientMessage(overTheWire(message));
    expect(result).toEqual({ success: true, data: message });
  });
});
