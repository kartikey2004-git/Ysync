# Change: Phase 3 — `apps/server` core

Ref: [plan.md](../../plan.md) Phase 3, [system-design.md](../../system-design.md) §6.

## What this change does

Adds the WebSocket sync server: connection handling, the per-document
`Room` abstraction (live `Rga` + connected sockets + `seq` counter), and
cross-process fan-out via a pub/sub bus. Persistence (Postgres) is **not**
wired in yet — that's Phase 4. Rooms in this phase are purely in-memory:
a room's document state is lost if it's evicted or the process restarts.
`ack` is sent immediately after local apply+broadcast rather than after a
durable commit, since there's nothing to durably commit to yet. Both of
these get corrected in Phase 4 without changing this phase's public shape
(`Room`/`RoomManager` already take a `seq` counter and an ack hook the
persistence writer will eventually gate).

## Design choice: pub/sub and presence behind interfaces

system-design.md §6.2/§6.5 call for Redis pub/sub fan-out and a Redis-backed
presence store. Rather than hard-wiring `ioredis` into `RoomManager`, both
are defined as small interfaces (`PubSubBus`, `PresenceStore`) with two
implementations each:

- `RedisPubSubBus` / `RedisPresenceStore` — the real thing, using `ioredis`.
- `InMemoryPubSubBus` / `InMemoryPresenceStore` — an in-process fake with
  the same contract.

This is what makes the Phase 3 exit criteria ("two server instances, same
Redis, clients on different instances see each other's ops/presence")
testable without requiring a live Redis in the default `npm test` run:
the multi-instance fan-out test creates two independent `RoomManager`s
(simulating two processes) sharing one `InMemoryPubSubBus`, which exercises
exactly the same cross-instance code path `RoomManager` uses in
production, just with the transport faked. The real `RedisPubSubBus` gets
its own integration test, gated with `test.skipIf` on a reachable
`REDIS_URL` so it degrades gracefully on a machine without Redis running,
rather than being silently untested. This machine has Docker available, so
I'll run that gated test for real once against a throwaway
`docker run redis:7-alpine` container as part of verifying this change,
then leave the committed suite Redis-optional.

## Files to add

- `apps/server/package.json`, `tsconfig.json`, `vitest.config.ts`.
  Dependencies: `express`, `ws`, `ioredis`, `@ysync/crdt`, `@ysync/protocol`.
- `apps/server/src/pubsub/PubSubBus.ts` — interface:
  `publish(channel, message)`, `subscribe(channel, handler)`,
  `unsubscribe(channel)`.
- `apps/server/src/pubsub/InMemoryPubSubBus.ts`, `RedisPubSubBus.ts`.
- `apps/server/src/presence/PresenceStore.ts` — interface:
  `set(docId, replicaId, data)`, `remove(docId, replicaId)`,
  `list(docId)`, plus a way to react to TTL expiry (heartbeat sweep).
- `apps/server/src/presence/InMemoryPresenceStore.ts`,
  `RedisPresenceStore.ts` (Redis hash for data + sorted set for
  last-seen, swept on an interval; matches system-design.md §6.5 —
  ephemeral, never touches Postgres).
- `apps/server/src/room.ts` — `Room`: holds the live `Rga`, connected
  sockets (keyed by `replicaId`), the `seq` counter; `applyLocalOp`,
  `applyRemoteOp` (from pub/sub), `join`, `leave`, idle eviction timer.
- `apps/server/src/roomManager.ts` — `RoomManager`: lazily creates/evicts
  `Room`s, wires each room's local broadcasts to `PubSubBus.publish` and
  subscribes so remote publishes fan out to the room's local sockets
  (without re-publishing what it just received — no echo loop).
- `apps/server/src/server.ts` — `createServer({ pubSubBus, presenceStore,
  idleTimeoutMs? })` factory returning `{ httpServer, wss, roomManager }`.
  Dependency-injected so tests can run fully in-memory or against real
  Redis without changing the server logic. Handles the WS message
  dispatch: first message on a socket must be `join` (validated via
  `@ysync/protocol`'s `parseClientMessage`) or the socket is closed with
  an `error`; subsequent messages are routed to that socket's `Room`.
- `apps/server/src/index.ts` — process entry point: reads `PORT`/`REDIS_URL`
  from env, builds the real Redis-backed instances, calls `createServer`,
  listens. Not exercised by tests (no real process spawning here).
- `apps/server/test/room.test.ts` — unit tests for `Room` (apply/broadcast
  bookkeeping, idle eviction).
- `apps/server/test/roomManager.multiInstance.test.ts` — two
  `RoomManager`s sharing one `InMemoryPubSubBus`; asserts ops applied on
  one are visible on the other via fan-out, with no double-apply/echo.
- `apps/server/test/ws.integration.test.ts` — real `ws` server on an
  ephemeral port, real `WebSocket` client connections (single instance,
  in-memory bus/presence), driving the actual join → op → broadcast →
  presence → leave message flow over real sockets.
- `apps/server/test/redisPubSubBus.integration.test.ts` — same contract
  test as the in-memory bus, against real `ioredis`, `test.skipIf`'d when
  `REDIS_URL` isn't reachable.

## Out of scope for this change

- No Postgres/Prisma, no durable persistence, no snapshot/GC (Phase 4).
- No `apps/web` client (Phase 5) — verified via the `ws` package acting as
  a raw test client, not the real browser client.
- `ack` is a same-process placeholder, not a durability guarantee yet.

## Exit criteria

- `npm test -w apps/server` passes without requiring Redis to be running.
- The Redis integration test passes when run against a real Redis
  (verified manually this session via a throwaway Docker container).
- `npm run build -w apps/server` (tsc) is clean.
