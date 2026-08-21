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

// simulates exactly the JSON round-trip a message takes over the wire
function overTheWire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

const opId = { counter: 1, replicaId: "alice" };

// Every client message type should survive a JSON round-trip unchanged.
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
    { type: "presence", docId: "doc-1" }, // every awareness field is optional
    { type: "leave", docId: "doc-1" },
  ];

  test.each(samples)("round-trips %j", (message) => {
    const result = parseClientMessage(overTheWire(message));
    expect(result).toEqual({ success: true, data: message });
  });

  // parseClientMessage discriminates on "type" before delegating to the
  // per-message schema, so also check the union schema accepts everything directly.
  test("clientMessageSchema accepts the same samples directly", () => {
    for (const message of samples) {
      expect(clientMessageSchema.safeParse(overTheWire(message)).success).toBe(true);
    }
  });
});

// Same coverage as above, but for the server -> client direction.
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

// Parsers must fail closed on bad shapes rather than throwing or silently coercing.
describe("rejects malformed input", () => {
  test("missing required field", () => {
    const result = parseClientMessage({ type: "join", docId: "doc-1" }); // replicaId/sinceSeq are missing
    expect(result.success).toBe(false);
  });

  test("wrong type literal", () => {
    const result = parseClientMessage({ type: "not-a-real-type", docId: "doc-1" });
    expect(result.success).toBe(false);
  });

  test("op with wrong shape is rejected", () => {
    expect(opSchema.safeParse({ type: "insert", id: opId }).success).toBe(false); // value is missing
  });

  test("non-object input", () => {
    expect(parseClientMessage("just a string").success).toBe(false);
    expect(parseServerMessage(null).success).toBe(false);
  });

  // unbounded string/array fields let a client send oversized payloads to exhaust server memory; these caps close that hole.

  test("docId over the length cap is rejected", () => {
    const result = parseClientMessage({
      type: "join",
      docId: "d".repeat(201),
      replicaId: "alice",
      sinceSeq: 0,
    });
    expect(result.success).toBe(false);
  });

  test("presence name over the length cap is rejected", () => {
    const result = parseClientMessage({
      type: "presence",
      docId: "doc-1",
      name: "n".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  test("an op batch over the size cap is rejected", () => {
    const ops = Array.from({ length: 2001 }, (_, i) => ({
      type: "insert" as const,
      id: { counter: i + 1, replicaId: "alice" },
      originId: null,
      value: "x",
    }));
    const result = parseClientMessage({ type: "op", docId: "doc-1", ops });
    expect(result.success).toBe(false);
  });

  test("an insert op value over the length cap is rejected", () => {
    const result = opSchema.safeParse({
      type: "insert",
      id: opId,
      originId: null,
      value: "x".repeat(4001),
    });
    expect(result.success).toBe(false);
  });

  // Each schema must enforce its own required fields, not just accept whatever shape another message type would.

  test("individual message schemas reject cross-contaminated fields missing", () => {
    expect(joinMessageSchema.safeParse({ type: "join", docId: "d" }).success).toBe(false);
    expect(opMessageSchema.safeParse({ type: "op", docId: "d", ops: [] }).success).toBe(false); // ops can't be empty
    expect(presenceMessageSchema.safeParse({ type: "presence" }).success).toBe(false); // docId is missing
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
