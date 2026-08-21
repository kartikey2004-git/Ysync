import { describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { Room } from "../src/room.js";

interface FakeSocket {
  socket: WebSocket;
  sent: string[];
  setReadyState: (state: number) => void;
}

function fakeSocket(): FakeSocket {
  const sent: string[] = [];
  const fake = {
    readyState: 1,
    OPEN: 1,
    send: (data: string) => {
      sent.push(data);
    },
  };
  return {
    socket: fake as unknown as WebSocket,
    sent,
    setReadyState: (state: number) => {
      fake.readyState = state;
    },
  };
}

// Room has no external dependencies, it's a plain data structure — so these are pure
// unit tests, no Redis, no Postgres, no real socket needed, just a fake send() to check who got what.
describe("Room", () => {
  test("join/leave tracks connected sockets", () => {
    const room = new Room("doc-1");
    const { socket } = fakeSocket();

    expect(room.isEmpty()).toBe(true);
    room.join("alice", socket);
    expect(room.isEmpty()).toBe(false);
    expect(room.hasSocket("alice")).toBe(true);
    expect(room.replicaIds()).toEqual(["alice"]);

    room.leave("alice");
    expect(room.isEmpty()).toBe(true);
    expect(room.hasSocket("alice")).toBe(false);
  });

  test("applyOps mutates the underlying document and adopts the given seq", () => {
    const room = new Room("doc-1");
    expect(room.currentSeq()).toBe(0);

    room.applyOps([{ type: "insert", id: { counter: 1, replicaId: "alice" }, originId: null, value: "h" }], 1);

    expect(room.currentSeq()).toBe(1);
    expect(room.snapshot()).toEqual([
      { id: { counter: 1, replicaId: "alice" }, originId: null, value: "h", tombstone: false, attrs: undefined },
    ]);
  });

  test("broadcast sends to every socket except the excluded one", () => {
    const room = new Room("doc-1");
    const alice = fakeSocket();
    const bob = fakeSocket();
    room.join("alice", alice.socket);
    room.join("bob", bob.socket);

    room.broadcast({ type: "presence-leave", docId: "doc-1", replicaId: "carol" }, "alice");

    expect(alice.sent).toHaveLength(0);
    expect(bob.sent).toHaveLength(1);
    expect(JSON.parse(bob.sent[0] as string)).toEqual({
      type: "presence-leave",
      docId: "doc-1",
      replicaId: "carol",
    });
  });

  test("sendTo only reaches the target socket", () => {
    const room = new Room("doc-1");
    const alice = fakeSocket();
    const bob = fakeSocket();
    room.join("alice", alice.socket);
    room.join("bob", bob.socket);

    room.sendTo("bob", { type: "ack", docId: "doc-1", seq: 1, opIds: [] });

    expect(alice.sent).toHaveLength(0);
    expect(bob.sent).toHaveLength(1);
  });

  test("join returns the previous socket for a reused replicaId, and leave only removes a matching socket", () => {
    const room = new Room("doc-1");
    const first = fakeSocket();
    const second = fakeSocket();

    expect(room.join("alice", first.socket)).toBeNull();
    expect(room.join("alice", second.socket)).toBe(first.socket);
    expect(room.hasSocket("alice")).toBe(true);

    // a leave(replicaId, first.socket) coming from the old (replaced) socket's own close
    // handler shouldn't evict the new (second) socket — the identity doesn't match
    room.leave("alice", first.socket);
    expect(room.hasSocket("alice")).toBe(true);

    // the actual owner (second) leaving itself should delete it
    room.leave("alice", second.socket);
    expect(room.hasSocket("alice")).toBe(false);
  });

  test("broadcast skips sockets that are no longer OPEN", () => {
    const room = new Room("doc-1");
    const alice = fakeSocket();
    alice.setReadyState(3); // CLOSED — the socket is closed, don't send it a message
    room.join("alice", alice.socket);

    room.broadcast({ type: "presence-leave", docId: "doc-1", replicaId: "bob" });

    expect(alice.sent).toHaveLength(0);
  });
});
