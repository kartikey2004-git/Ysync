# Change: Phase 5 — `apps/web` scaffold + editor

Ref: [plan.md](../../plan.md) Phase 5, [system-design.md](../../system-design.md) §8.

## What this change does

Adds the Next.js client: a `DocumentClient` (system-design.md §8.1) owning
the local `Rga`, the WS connection (join/op/presence/leave, reconnect with
backoff, presence heartbeat), and IndexedDB persistence (§8.2); a
`useDocument(docId)` hook wrapping it for React; and a Quill-bound editor
component translating between Quill `Delta`s and CRDT ops. Exit criterion
per plan.md: two browser tabs on the same doc, one server instance, live
edits and presence.

Offline/reconnect is **not** the focus of this phase (that's Phase 6) —
but `DocumentClient`'s reconnection handling is designed to be correct now
rather than reworked later: the server only ever replies to `join` with a
full `snapshot` (Phase 3/4 don't implement incremental `sync` catch-up
yet), so on every connect/reconnect the client rebuilds its `Rga` from
that snapshot and **reapplies its own not-yet-acked outbox ops on top**
(`Rga.apply` is idempotent, per `packages/crdt`'s property tests), then
re-sends the outbox as a fresh `op` message. That's the right merge
behavior whether this is the first connection or a reconnect after a drop;
Phase 6 adds the scenario tests and manual offline-toggle verification for
it, plus a real `sinceSeq`-aware incremental `sync` on the server side.

## Scope decisions (called out explicitly, not silently dropped)

- **No rich-text formatting yet.** `packages/crdt`'s marker-node handling
  has the bug flagged in plan.md's Phase 5 entry (an `attrs`-bearing node's
  `value` is silently dropped by `read()`/`getContentsForEditor()`). Wiring
  Quill's bold/italic/etc. through to CRDT `attrs` now would immediately
  hit that bug. The editor is plain text for this phase; rich text is
  explicit future work once that's fixed.
- **No in-text remote cursor rendering.** Building a Quill cursor-blot
  module (à la Yjs's `quill-cursors`) to draw *other* users' carets inside
  the text is real additional scope. Presence is instead shown as a
  simple "who's here" list (name + color) alongside the editor — still a
  visible, demoable awareness feature, just not inline carets.
- **Automated tests are narrow here on purpose.** `DocumentClient` itself
  (WebSocket + IndexedDB + reconnect timing) isn't unit-tested in this
  phase — meaningfully testing it needs the same investment Phase 6 is
  already scoped to make (fake timers, a mocked transport, scenario
  harnesses). What *is* pulled out and unit-tested now is the one pure,
  dependency-free piece: translating a Quill `Delta` into an ordered list
  of index-based CRDT edits. Everything else is verified by actually
  running the app in a browser (two tabs) per this phase's exit criterion.

## Design

### `DocumentClient` (`src/lib/documentClient.ts`)

- Owns a `Rga` (from `@ysync/crdt`), a WS connection, an in-memory +
  IndexedDB-backed outbox (ops applied locally, not yet acked), and a
  presence map (other replicas' cursor/name/color).
- `insertText(index, value)` / `deleteText(index)`: apply to the local
  `Rga` immediately (optimistic), append to the outbox (memory +
  IndexedDB), send an `op` message if connected.
- On WS `open`: send `join { docId, replicaId, sinceSeq: lastAckedSeq }`.
- On `snapshot`: `Rga.fromSnapshot(state)`, reapply outbox ops on top,
  flush the outbox as a fresh `op` message if non-empty, notify
  subscribers.
- On `broadcast-op`: `rga.applyAll(ops)`, notify.
- On `ack`: drop matching entries from the outbox (by opId), persist
  `lastAckedSeq`, notify.
- On `presence-update`/`presence-leave`: update the presence map, notify.
- On close (not an intentional `disconnect()`): reconnect with capped
  exponential backoff.
- While connected: a heartbeat interval re-sends the last known
  cursor/selection so the server's presence TTL (system-design.md §6.5)
  doesn't expire this client.
- `subscribe(listener)` / `getSnapshot()`: the `useSyncExternalStore`
  contract `useDocument` renders from.

### IndexedDB (`src/lib/db.ts`, via the `idb` package)

Exactly the three stores from system-design.md §8.2:

- `documents`: `{ docId, lastAckedSeq, snapshotState }` — the last known
  server-acked state, so a reload doesn't start from nothing.
- `outbox`: `{ docId, opId, op, createdAt }`, indexed by `docId`.
- `replica`: `{ docId, replicaId }` — generated once per doc per browser
  and reused, so reconnects present a stable identity. Also carries a
  generated display name + color for presence (kept in the same record
  rather than a fourth store — it's part of "this browser's identity for
  this doc", not separate durable state).

### Editor (`src/components/Editor.tsx`)

- `deltaToEdits(delta, currentLength)` (`src/lib/deltaToEdits.ts`) — the
  one pure, unit-tested piece: walks a Quill `Delta`'s ops
  (`retain`/`insert`/`delete`) and a starting cursor position, producing
  an ordered list of `{ kind: "insert", index, value } | { kind: "delete", index }`
  edits, one per character (matching `Rga`'s char-at-a-time API).
  Embedded (non-string) inserts are skipped — out of scope.
- On Quill `text-change` with `source === "user"`: run the delta through
  `deltaToEdits` and call `documentClient.insertText`/`deleteText` for
  each. Quill has already applied the user's own edit to its own
  document, so nothing needs to be written back to Quill here.
- On `documentClient` state changes (remote ops, snapshot reconciliation):
  recompute the full `Delta` via `rga.getContentsForEditor()`, diff it
  against Quill's current contents (`Delta#diff`, from the `quill-delta`
  package Quill itself depends on), and apply just that diff via
  `quill.updateContents(diff, "silent")` — preserves the local cursor
  instead of the jump/reset a full `setContents` replace would cause.
- On Quill `selection-change` with `source === "user"`: forward
  `{ cursor, selection }` to `documentClient.updatePresence`.

### Next.js app

- App Router, scaffolded via `create-next-app` (TypeScript, ESLint, no
  Tailwind — kept minimal), then adjusted into the workspace (`@ysync/web`,
  `@ysync/crdt`/`@ysync/protocol`/`idb`/`quill` deps, no local lockfile —
  installs happen at the repo root).
- `/` — landing page: generates a random slug and links to `/doc/[slug]`.
- `/doc/[slug]` — the editor page (client component): `useDocument(slug)`,
  renders `Editor` + a presence list.
- `NEXT_PUBLIC_WS_URL` env var for the server's WS URL, defaulting to
  `ws://localhost:8080`.

## Bugs caught by actually running the app in a browser

`npm run build` alone didn't catch either of these — both only showed up
when the `run` skill drove two real browser contexts against the live
dev servers:

1. **Quill crashes Next.js's SSR pass.** `Editor.tsx` is a `"use client"`
   component, but Next still evaluates client-component modules during
   SSR to produce the initial HTML. `quill` touches `document` at
   module-evaluation time (not just when instantiated), so the server
   process threw `ReferenceError: document is not defined` on every
   `/doc/[slug]` request. Fixed by loading `Editor` via `next/dynamic(...,
   { ssr: false })` from `DocEditor.tsx`, which keeps the module out of
   the server bundle entirely rather than just guarding its usage.
2. **A real hydration mismatch from `useDocument`.** The first version
   constructed `DocumentClient` directly in the hook's render body,
   guarded by `typeof window !== "undefined"`. That guard is true during
   the browser's *first* render pass too (hydration happens client-side
   before any effect runs), so the client's first render already had a
   non-null `DocumentClient` while the server had rendered the `null`
   branch — exactly the "server/client branch on `typeof window`" case
   React's own hydration-mismatch warning names. Fixed by moving
   construction into a `useEffect` with `useState` (never directly in the
   render body, even guarded), so both the server and the client's first
   render agree on `null` until the effect runs post-mount.

With both fixed, a real two-browser-context test (via Playwright, driven
by the `run` skill) against live `apps/server`/`apps/web` dev servers
(Redis + Postgres up) confirmed: typed text in one tab appears in the
other, each tab's presence list shows the other's generated name/color,
connection state reaches `OPEN` in both, and no console errors in either
tab.

## Exit criteria

- `npm run build -w apps/web` succeeds.
- `npm run dev -w apps/web` plus `npm run dev -w apps/server` (with Redis
  + Postgres up): two browser tabs on the same `/doc/<slug>` see each
  other's typed text and presence entries live — verified manually this
  session via the `run` skill, not just asserted.
- `deltaToEdits` unit tests pass (`npm test -w apps/web`).
