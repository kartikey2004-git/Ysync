# Change: Phase 4 — Postgres persistence

Ref: [plan.md](../../plan.md) Phase 4, [system-design.md](../../system-design.md) §6.3, §6.4, §7.

## What this change does

Adds durable storage for documents: a Prisma-backed Postgres schema
(`Document` / `Operation` / `Snapshot`), a `PersistenceStore` abstraction
`RoomManager` uses for both the write path (append ops, periodic
snapshot+GC) and the read path (cold room hydration on `join`), replacing
Phase 3's in-memory-only rooms and immediate-ack placeholder. Same
interface-with-two-adapters pattern as `PubSubBus`/`PresenceStore`/
`SeqAllocator`: a `PrismaPersistenceStore` (real) and an
`InMemoryPersistenceStore` (fake, same contract) so the "kill and restart,
state recovers from Postgres" exit criterion is testable fast and
deterministically by default, with a real-Postgres integration test
gated on reachability (same `describe.skipIf` pattern as the Redis tests),
verified for real this session via a throwaway `postgres:16-alpine`
Docker container.

## Schema

```prisma
model Document {
  id        String   @id            // the client-facing docId, not a separate generated id
  latestSeq Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Operation {
  id        BigInt   @id @default(autoincrement())
  docId     String
  seq       Int                     // the batch seq this op was part of; several rows can share one seq
  opId      String                  // stringified OpId — the insert's own id, or the delete's targetId
  type      String                  // "insert" | "delete"
  originId  String?
  value     String?
  attrs     Json?
  createdAt DateTime @default(now())

  @@unique([docId, opId])
  @@index([docId, seq])
}

model Snapshot {
  id        String   @id @default(cuid())
  docId     String
  atSeq     Int
  state     Json                    // RgaSnapshotNode[] with tombstones compacted
  createdAt DateTime @default(now())

  @@index([docId, atSeq])
}
```

Deviates from system-design.md §7's original sketch in one way: `Document.id`
is the client-provided `docId` string directly rather than a separate
generated `cuid` with a `slug` column — nothing built so far (Redis channel
names, Room, RoomManager) distinguishes an internal id from a slug, so
adding that split now would be speculative. `@@unique([docId, opId])` is
what makes `appendOps` safe to call redundantly (see below) — a duplicate
insert is silently ignored via `skipDuplicates`.

## Durability + snapshot design

- **`appendOps(docId, seq, ops)`**: called from `RoomManager.applyClientOp`
  *after* the local broadcast + pub/sub publish (system-design.md §6.3 —
  durability is off the fan-out hot path), and the `ack` to the sender is
  sent only once this durably commits. Every process that observes an op —
  not just the one that originated it — may attempt to persist it (a
  process that only saw an op via pub/sub fan-out still calls
  `appendOps` for it); the `(docId, opId)` unique constraint makes this
  redundancy harmless rather than something requiring leader election.
  Known gap, not solved here: if the originating process crashes between
  broadcasting and persisting, and no other process happened to also
  receive+persist that op, it's visible to whoever was live but not
  durable. Acceptable for this project's scope; a production system would
  want at least one more replica always persisting.
- **Snapshot + GC**: `RoomManager`'s existing per-room tick (already
  running for presence sweep) also checks each room's op-count-since-last-
  snapshot; past a threshold, it materializes the room's state, compacts
  tombstones (`packages/crdt`'s `compactTombstones`), writes a `Snapshot`
  row, and deletes now-redundant `Operation` rows (`seq <= atSeq`) in the
  same transaction.
- **Cold load / join catch-up**: `RoomManager.getOrCreateRoom` now calls
  `persistenceStore.load(docId)` before constructing a brand-new `Room` —
  latest snapshot (if any) + every `Operation` row after it, replayed in
  order. `Room` gets a `Room.hydrate(...)` factory for this instead of
  always starting from an empty `Rga`.

## Files to add

**Deviation from the plan below, decided mid-implementation at the user's
request:** Prisma is on **v7**, not v5 as first drafted, and the schema/
client live in a new **`packages/database`** workspace rather than a
root-level `prisma/` folder — treated the same as `packages/crdt`/
`packages/protocol` rather than sitting oddly at the repo root only
`apps/server` would ever use. Concretely:

- `packages/database/prisma/schema.prisma` + `prisma/migrations/` (a real
  initial migration, generated against a throwaway Postgres via
  `prisma migrate dev`, not just `db push` — meant to look like how the
  project would actually deploy per plan.md Phase 8) + `prisma.config.ts`
  (Prisma 7 moved the datasource URL here for Migrate; `schema.prisma`
  itself can no longer contain `datasource.url`).
- `packages/database/src/client.ts` — `createPrismaClient(databaseUrl)`,
  the one place the Prisma 7 driver-adapter wiring happens (`@prisma/adapter-pg`'s
  `PrismaPg`, mandatory now — v7 dropped the Rust query engine). `src/index.ts`
  re-exports `PrismaClient`/`Prisma`/model types from the generated client.
  The generator now emits real `.ts` source outside `node_modules`
  (`packages/database/generated/prisma/`, gitignored, built by this
  package's own `tsc` pass) instead of a prebuilt `node_modules/@prisma/client`.
- Root `package.json`: `db:generate`/`db:migrate`/`db:deploy` scripts that
  delegate to the `packages/database` workspace; no root `prisma`
  dependency (it lives in `packages/database` where the schema does).
- `apps/server` depends on `@ysync/database` (workspace) instead of
  `@prisma/client`/`@prisma/adapter-pg` directly.
- `apps/server/src/persistence/PersistenceStore.ts` — interface:
  `load(docId)`, `appendOps(docId, seq, ops)`, `writeSnapshot(docId, atSeq, state)`, `close()`.
- `apps/server/src/persistence/InMemoryPersistenceStore.ts` — fake with the
  same contract (Maps standing in for the three tables, including
  GC-on-snapshot and unique-opId dedup, so it's a faithful enough stand-in
  for the RoomManager-level tests to be meaningful).
- `apps/server/src/persistence/PrismaPersistenceStore.ts` — real adapter,
  built on `@ysync/database`'s `createPrismaClient`.
- `apps/server/src/util/opId.ts` — `opIdOf(op)`/`opIdKeyOf(op)`, factored
  out of `roomManager.ts` since the persistence layer needs the same
  "an op's identity is its insert id or its delete's targetId" logic.
- Updates to `room.ts` (constructor takes an optional initial `Rga`;
  `Room.hydrate(...)`; `getOpsSinceSnapshot`/`resetOpsSinceSnapshot`/
  `compactTombstones`) and `roomManager.ts` (`persistenceStore` +
  `snapshotOpThreshold` wired into `getOrCreateRoom`, `applyClientOp`,
  and the tick).
- `apps/server/scripts/storageGrowthBenchmark.ts` — the benchmark from
  system-design.md §9.4. What Phase 4's GC actually bounds is the
  **`Operation` table's row count for a document at any point in time**,
  not total bytes: without GC it holds one row per op ever submitted,
  forever; with it, never more than `snapshotOpThreshold` rows, regardless
  of total edit-history length. That's a provable O(1)-vs-O(N) row-count
  bound, so the script demonstrates exactly that (simulating N snapshot
  cycles through `packages/crdt` directly and comparing total ops ever
  generated against the constant per-cycle row cap) rather than reporting
  a single byte-ratio. It also honestly reports the smaller, secondary
  effect of compacting tombstone *payloads* within one snapshot — which
  turned out to be negligible (sometimes even net-negative) for
  single-character values, since nulling a node's value isn't reliably
  smaller than the short string it replaces; noted in the script's
  comments rather than glossed over. Run manually (`npm run
  benchmark:storage -w apps/server`), not part of `npm test` — it's a
  report, not a pass/fail gate, per plan.md.
- Tests: `apps/server/test/persistence.inMemory.test.ts` (contract tests:
  append/load/snapshot+GC round-trip), `apps/server/test/roomManager.restart.test.ts`
  (fresh `RoomManager` over the same `InMemoryPersistenceStore` — the
  in-process stand-in for "kill and restart the server" — asserts state
  recovers), `apps/server/test/persistence.postgres.integration.test.ts`
  (same contract against real Postgres, `describe.skipIf`'d on
  reachability, verified this session via Docker).
- Existing Phase 3 tests (`roomManager.multiInstance.test.ts`,
  `ws.integration.test.ts`) get a `persistenceStore:
  new InMemoryPersistenceStore()` added to their `RoomManager`/`createServer`
  options — no behavioral changes to those tests otherwise, since a
  brand-new in-memory store still cold-loads to "empty document."

## Out of scope for this change

- No leader election / single-writer coordination for snapshot triggering
  (every process with a live room independently decides to snapshot;
  redundant but not incorrect, since compaction is deterministic given the
  same materialized state).
- No document creation/access-control endpoint — a `Document` row is
  created implicitly on first `appendOps` (`upsert`).

## Exit criteria

- `npm test -w apps/server` passes without requiring Postgres.
- The Postgres integration tests pass when run against a real Postgres
  (verified manually this session via a throwaway Docker container).
- `roomManager.restart.test.ts` demonstrates the Phase 4 headline
  guarantee: document state survives a `RoomManager` (i.e. "server
  process") being discarded and recreated over the same persisted store.
- `storageGrowthBenchmark.ts` runs and reports a naive-vs-compacted byte
  ratio for a real synthetic session (numbers reported as observed, not
  asserted against a hardcoded target — see system-design.md §9.4).
