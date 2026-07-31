# Change: Phase 0 scaffold + Phase 1 CRDT port

Ref: [plan.md](../../plan.md) Phase 0 & Phase 1, [system-design.md](../../system-design.md) §4.

## What this change does

Sets up the npm-workspaces monorepo skeleton (just enough to host a real
package, not the full `apps/web`/`apps/server` yet) and ports the RGA CRDT
from `backend/src/crdt/tilist.js` into a typed, isomorphic
`packages/crdt` workspace — including the `originId`-based anchoring fix
called out in system-design.md §4.2, causal receive-buffering, tombstone
compaction, and property-based convergence tests.

The existing `backend/` and `frontend/` are left untouched and runnable —
nothing here wires the new package into them yet (that's Phase 3/5).

## Files to add

- `package.json` (root) — `"workspaces": ["packages/*", "apps/*"]`, shared
  devDependencies (`typescript`).
- `tsconfig.base.json` (root) — strict TS config shared by all workspaces.
- `packages/crdt/package.json`, `packages/crdt/tsconfig.json`,
  `packages/crdt/vitest.config.ts`.
- `packages/crdt/src/opId.ts` — `OpId` type, `compareOpId`, `opIdEquals`,
  `opIdToString`/`opIdFromString`.
- `packages/crdt/src/op.ts` — `Op` union (`insert` | `delete`),
  `FormatMark` type.
- `packages/crdt/src/node.ts` — `RgaNode` type.
- `packages/crdt/src/rga.ts` — the `Rga` class:
  - `localInsert(index, value, attrs?)` / `localDelete(index)` — index-based
    convenience API for the editor binding; builds the `Op` (with
    `originId` resolved from the local list) and applies it, returning the
    `Op` for the caller to send over the wire / write to the log.
  - `apply(op: Op)` — the replication entry point. Idempotent (checks
    `nodesById` before applying), causally buffers ops whose dependency
    (`originId`/`targetId`) hasn't arrived yet, retries the buffer whenever
    a dependency is satisfied.
  - Insert ordering rule: siblings inserted at the same `originId` form a
    contiguous run ordered by descending `OpId` — this is the concrete
    algorithm behind the "insert relative to a fixed anchor, not a live
    index" fix.
  - `read()`, `toSnapshot()`/`fromSnapshot()`, `compactTombstones()`,
    `getContentsForEditor()` (Quill-`Delta`-shaped, porting the existing
    marker-node logic for rich text).
- `packages/crdt/test/rga.test.ts` — direct port of the scenarios already
  in `backend/test/tilist.test.js` (insert/delete/read, mixed ops), against
  the new API.
- `packages/crdt/test/convergence.property.test.ts` — `fast-check`
  property test: N simulated replicas apply randomized concurrent
  insert/delete streams in shuffled (causally-valid) order; asserts all
  replicas converge to the same `read()` output. Configured to exercise
  5,000+ total ops per property run.

## Out of scope for this change

- No networking, no server, no Postgres/Redis — pure in-memory CRDT only.
- No `packages/protocol` yet (Phase 2).
- Not wiring this package into `frontend/`'s Quill editor yet — that's
  Phase 5, once `apps/web` exists.

## Exit criteria

- `npm install` at repo root resolves the new workspace.
- `npm test -w packages/crdt` passes, including the property-based suite.
- `packages/crdt` has no dependency on DOM or Node-only APIs (isomorphic).
