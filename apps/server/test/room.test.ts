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

// Room ka koi external dependency nahi hai, plain data structure hai — isliye
// yeh pure unit tests hain, na Redis chahiye na Postgres na real socket,
// bas fake send() se check kar lete hain kisko kya mila.
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

  test("broadcast skips sockets that are no longer OPEN", () => {
    const room = new Room("doc-1");
    const alice = fakeSocket();
    alice.setReadyState(3); // CLOSED — socket band ho chuka, isko message nahi bhejna
    room.join("alice", alice.socket);

    room.broadcast({ type: "presence-leave", docId: "doc-1", replicaId: "bob" });

    expect(alice.sent).toHaveLength(0);
  });
});
