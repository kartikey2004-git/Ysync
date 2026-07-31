# Change: Phase 6 — offline-first sync end-to-end

Ref: [plan.md](../../plan.md) Phase 6, [system-design.md](../../system-design.md) §8.3, §9.2.

## What this change does

Two things Phase 5's change doc explicitly deferred to this phase:

1. **Real `sinceSeq`-aware incremental catch-up on the server.** Phase 3/4
   had `join` always reply with a full `snapshot` regardless of what the
   client already had. `Room` now tracks its own in-memory op log
   (seq-tagged batches) since it was created/hydrated, and `RoomManager.join`
   decides between an incremental `sync` (just the ops after `sinceSeq`) and
   a full `snapshot` fallback (when the requested `sinceSeq` predates what
   this room instance has tracked in memory — e.g. right after a cold
   hydration whose snapshot is newer than the client's last-known seq).
2. **A real, testable offline → reconnect scenario**, not just individual
   unit tests of the pieces. `DocumentClient`'s reconciliation logic (already
   built in Phase 5) is unified across `snapshot`/`sync` so both flush the
   outbox afterward; a `setSimulatedOffline` toggle lets the offline path be
   driven manually in a real browser; and a scenario test drives several
   simulated clients through concurrent offline edits + reconnect directly
   against `RoomManager` (no WS/browser needed) to assert convergence and
   zero op loss at a real, measured scale.

## Server: `Room` gets an in-memory op log

```ts
private opLog: { seq: number; ops: Op[] }[] = [];
private coverageFloor = 0; // full op history is available for seq > coverageFloor
```

- `applyOps` appends each batch to `opLog` (in addition to what it already did).
- `Room.hydrate` seeds `opLog` from the persisted trailing-ops batches and
  sets `coverageFloor` to the snapshot's `atSeq` — everything at or before
  that point is only available as the compacted snapshot, not as replayable
  ops.
- New `getOpsSince(sinceSeq): Op[] | null` — `[]` if the caller is already
  caught up, the flattened ops if `opLog` fully covers the gap, `null` if
  there's a gap this room instance can't fill from memory (caller must fall
  back to a full snapshot).
- Snapshotting now also calls `advanceCoverageFloor(atSeq)` (folded into
  what was `resetOpsSinceSnapshot`), trimming `opLog` down to just what's
  still needed — this is the in-memory mirror of the real `Operation` table
  GC from Phase 4, so `opLog` doesn't grow without bound either.

This requires `PersistenceStore#load` to return ops **grouped by their
original seq batch** (`{ seq: number; ops: Op[] }[]`) rather than a flat
`Op[]` — otherwise `Room.hydrate` can't correctly seed `opLog`'s batch
boundaries. Both `InMemoryPersistenceStore` and `PrismaPersistenceStore`
are updated; `Operation` rows are already stored with their batch's `seq`
column, so `PrismaPersistenceStore` just groups consecutive same-`seq`
rows after the existing ordered query.

`RoomManager.join` now takes `sinceSeq` and returns the catch-up decision
directly (`{ kind: "sync", seq, ops } | { kind: "snapshot", seq, state }`)
instead of just the `Room`; `server.ts` sends whichever `ServerMessage`
that maps to. `sinceSeq` defaults to `0` so every existing call site
(tests written before this change) keeps compiling — a fresh room with
`sinceSeq: 0` now correctly resolves to `{ kind: "sync", ops: [] }` instead
of unconditionally `snapshot`, which is why `ws.integration.test.ts`'s
first-join assertion changes.

## Client: unified reconciliation + a manual offline toggle

`DocumentClient`'s `snapshot` and `sync` handlers both now end by calling a
shared `flushOutbox()` (re-sending any not-yet-acked local ops as one `op`
message) — previously only the `snapshot` path did this inline, and `sync`
did nothing with the outbox at all, which would have silently stranded
offline edits made before a `sync`-eligible reconnect.

`setSimulatedOffline(offline: boolean)`: closes the live WS and skips
reconnect while `true` (local edits keep applying to the local `Rga` and
queuing in the outbox exactly as they would during a real network drop),
then reconnects on `false` — driving the exact same join → catch-up →
outbox-flush path a real reconnect does. Exposed as a checkbox in
`DocEditor` for the manual verification plan.md's Phase 6 asks for.

## Scenario test (`apps/server/test/offlineReconnect.scenario.test.ts`)

Four simulated clients (plain `Rga` + an outbox array — not the real
browser `DocumentClient`, which needs WebSocket/IndexedDB; this tests the
CRDT-convergence contract through the real `RoomManager`/`PersistenceStore`
integration path, which is the part Phase 5 didn't exercise) each perform
~65 edits while "offline" — inserts and occasional deletes, all contending
for the same insertion point (index 0), which is the maximally-conflicting
case: every edit from every client is concurrent with every other client's
edits at that same anchor. Total edits comfortably exceed 250 (asserted,
not just claimed).

Reconnect is simulated by flushing each client's whole offline outbox to
`RoomManager.applyClientOp` in turn. Assertions:

- **Zero data loss**: the final room snapshot's node count equals the total
  number of insert ops across all clients (deletes tombstone, never
  remove, so every inserted character is still accounted for).
- **Convergence**: an independent observer `Rga` that applies the exact
  same ops (but never touches `RoomManager` — pure `Rga.apply` calls)
  produces identical text to the room's materialized state. This is the
  same property `packages/crdt`'s property test already proves for the
  algorithm in isolation; here it's proving the server integration
  (seq assignment, persistence round-tripping, batching) doesn't break
  that guarantee.

A second, narrower test file (`apps/server/test/catchUp.test.ts`) unit-tests
`Room.getOpsSince`/`RoomManager.join`'s sync-vs-snapshot decision directly:
recent `sinceSeq` gets `sync`, a `sinceSeq` older than the coverage floor
(after a snapshot+GC) falls back to `snapshot`.

## Exit criteria

- `npm test -w apps/server` passes (existing tests updated for the new
  `LoadedDocument.ops` shape and `join`'s new return type / catch-up
  behavior). Verified against real Redis + Postgres too, not just the
  in-memory fakes.
- The scenario test passes with total simulated edits >= 250, asserting
  both zero-data-loss and full convergence. First draft of the test had a
  boundary bug, not a CRDT bug: the per-client edit-count range (60-69) x
  4 clients could bottom out at 240, under the 250 floor the test itself
  asserted — caught immediately by running it, fixed by raising the floor
  to 65-75 (worst case 260).
- Manual verification (via the `run` skill, Playwright against live dev
  servers with Redis + Postgres up): two browser tabs on the same doc;
  toggled "simulate offline" in tab A (badge → `CLOSED`); typed in A —
  confirmed the edit did *not* reach tab B while offline; typed in B
  (still online) concurrently; untoggled offline in A — confirmed both
  tabs converged to the identical final text with A's offline edit and
  B's concurrent edit both present, badge back to `OPEN`, zero console
  errors. (One test-process hiccup along the way: a leftover dev-server
  process from an earlier session was still bound to port 8080, so the
  first run's edits landed on that stale process/Postgres state instead
  of the fresh one — not a product bug, just needed the stale process
  killed and the scenario rerun against a clean doc id.)
