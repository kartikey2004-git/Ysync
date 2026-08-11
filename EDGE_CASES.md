# EDGE_CASES.md — YSync Production Audit

Scope: `packages/crdt`, `packages/protocol`, `apps/server`, `apps/web`, `packages/database`. Every finding below was confirmed by reading the actual source (file:line cited); several were empirically reproduced against the real code during the audit (noted per-finding). This document does not include purely hypothetical scenarios that aren't reachable from real code paths.

Related documents: [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) (failure-mode/blast-radius framing of the most severe items here), [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md), [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md).

---

## 1. Concurrent insert-with-attrs silently loses text content

### Root Cause
`Rga.localInsert(index, value, attrs?)` accepts a text `value` and a formatting `attrs` object on the *same* node with no validation that they're mutually exclusive. Both read paths — `read()` (`packages/crdt/src/rga.ts:108`) and `getContentsForEditor()` (`:117-145`) — treat any node with truthy `attrs` as a zero-width formatting marker and never emit its `value`.

### Trigger
Any caller that issues `localInsert(idx, "hello", { bold: true })` — i.e., inserting literal text and a format attribute in a single op, rather than always splitting into a zero-width marker op plus a separate plain-text op.

### Production Scenario
Empirically confirmed: `rga.localInsert(0, "hello", { bold: true }); rga.read()` → `""` (expected `"hello"`). If any future editor-binding code path (or a different client implementation, IME autocomplete-with-formatting, or a batch/import tool) ever constructs an insert this way, the text vanishes with no error, no exception, no log line.

### User Impact
Text a user typed disappears from their own view and every collaborator's view, permanently — the op is durably persisted (it round-trips through the wire protocol fine; the loss is purely a client-side rendering artifact of `read()`/`getContentsForEditor()`), so there is no error surface to alert anyone.

### Business Impact
Silent content loss in a collaborative editor is a trust-destroying bug class — users will not report "the software silently ate my text" as a bug, they'll just stop trusting the product.

### Detection
No detection today — no test in `packages/crdt/test/` combines `attrs` with a non-empty `value`. Would require a dedicated regression test or a runtime invariant assertion (`attrs` set ⇒ `value === null`).

### Prevention
Enforce the invariant at the `InsertOp` type level (make `value` and `attrs` a discriminated union, not both-optional siblings) and validate it in `parseClientMessage`/`insertOpSchema` (`packages/protocol/src/op.ts`).

### Fix
Split `localInsert` into `insertText(index, value)` and `insertMarker(index, attrs)`, or add a runtime `assert(!(value && attrs))` and reject/strip one side. Add a regression test.

### Severity
High

### Confidence
High — empirically reproduced.

### References
`packages/crdt/src/rga.ts:46-57` (localInsert), `:108` (read), `:117-145` (getContentsForEditor); `packages/crdt/src/node.ts:12-14`.

---

## 2. Multi-character insert values corrupt position/index semantics

### Root Cause
`RgaNode.value` and `InsertOp.value` are typed as arbitrary-length `string`, but `findNodeAtPosition` (`packages/crdt/src/rga.ts:267-284`) walks the linked list **one node per index unit**, while `read()` concatenates node values **character-counted**. The two indexing spaces are only consistent when every node holds exactly one character — an assumption the types don't enforce and no test exercises.

### Trigger
Any bulk/multi-character insert: `localInsert(0, "hello")` followed by `localInsert(5, "!")`.

### Production Scenario
Empirically confirmed: after inserting `"hello"` as one 5-character node, `localInsert(5, "!")` calls `findNodeAtPosition(4)`, which walks past the single node on its first step (list length 1) and returns `null` — so the new op anchors at the head instead of after "hello". Result: `rga.read()` → `"!hello"`, not the intended `"hello!"`.

### User Impact
Any code path that ever inserts more than one character per op (paste, IME composition commit, programmatic batch import, undo/redo replay) silently places content at the wrong position — cursor-relative edits land in the wrong place with no error.

### Business Impact
Paste is one of the most common editing operations; if any current or future client path routes paste through a multi-character `localInsert` instead of one-op-per-character, this is a high-frequency, user-visible corruption bug.

### Detection
Every existing test in `rga.test.ts` and `convergence.property.test.ts` inserts single-character strings only — this class of bug is completely untested and would not be caught by CI today.

### Prevention
Either (a) enforce `value.length === 1` at the type/schema level and require callers to split multi-character inserts into one op per character (matching how `deltaToEdits.ts` already behaves on the web client, see EDGE_CASES §6), or (b) redesign `findNodeAtPosition`/`read()` to be character-index-aware for multi-character nodes.

### Fix
Add a runtime assertion in `localInsert`/`apply` rejecting `value.length !== 1`, or fix the position-walking logic to account for multi-character node lengths. Add a property test with multi-character inserts.

### Severity
High

### Confidence
High — empirically reproduced.

### References
`packages/crdt/src/rga.ts:46-57` (localInsert), `:267-284` (findNodeAtPosition); `packages/crdt/src/node.ts:12`.

---

## 3. Concurrent/overlapping formatting marks scramble document content

### Root Cause
`getContentsForEditor()` (`packages/crdt/src/rga.ts:117-145`) treats any second marker node as unconditionally "closing" whatever attribute is currently open, without checking that the second marker's `attrs` actually match the first. It also only reads `Object.keys(node.attrs)[0]`, dropping every key beyond the first in a multi-key format mark. Because tombstoned nodes are skipped with no compensating state reset, a deleted "close" marker leaves the toggle state stuck open for the rest of the traversal.

### Trigger
Overlapping/nested formatting (e.g., open-bold, insert "a", open-italic, insert "b") or a remote delete landing on a marker node.

### Production Scenario
Empirically confirmed: for the sequence open-bold → "a" → open-italic → "b", the resulting Quill delta mislabels "a" as italic (should be bold) and "b" loses formatting entirely, with content order scrambled relative to intent.

### User Impact
Bold text renders as italic, formatting silently disappears, or spans of unrelated text pick up formatting they were never given — this is directly visible in the editor UI.

### Business Impact
This isn't a rare interleaving — any two users applying different formatting concurrently (a completely normal collaborative-editing action) can trigger it.

### Detection
No test in `packages/crdt/test/` combines `attrs` with concurrent or interleaved edits, nesting, or deletion of a marker node.

### Prevention
This requires an actual conflict-resolution design for formatting (e.g., a proper Peritext-style approach: marks identified by their own op-id, closed by matching id rather than list position, resilient to tombstoning) rather than the current single-slot toggle.

### Fix
Redesign format-mark representation to pair open/close markers by op-id rather than by traversal order, and make tombstoned markers not affect toggle state. This is a non-trivial CRDT design change, not a one-line fix.

### Severity
High

### Confidence
High — empirically reproduced and confirmed by static read.

### References
`packages/crdt/src/rga.ts:117-145`.

---

## 4. Op-id counter overflow causes silent id collision and wrong-node deletion

### Root Cause
`opIdSchema.counter` (`packages/protocol/src/op.ts:5`) accepts any non-negative integer-valued double with no `.max()`. `Rga.apply()` (`packages/crdt/src/rga.ts:86`) does `this.counter = Math.max(this.counter, current.id.counter)` with no upper bound. Once `counter` exceeds `2^53`, `nextId()`'s `counter += 1` becomes a no-op at IEEE-754 double granularity — every subsequent local op from that replica gets an identical id. `integrate()` (`:248`) does an unconditional `nodesById.set(key, newNode)`, silently overwriting the earlier node's map entry.

### Trigger
A single remote op with `counter: 2**60` (or any value ≥ `2^53`) reaching a victim replica via `apply()`.

### Production Scenario
Empirically confirmed end-to-end: after applying one attacker-crafted op with `counter: 2**60`, the victim's own next two local inserts both receive `id.counter === 2**60` (identical ids). Deleting the first insert by its own returned id instead deletes the second — **the wrong content is removed**, silently.

### User Impact
A user's own delete action removes different content than what they selected, with no error — silent, targeted-feeling corruption.

### Business Impact
This is reachable through `parseClientMessage`, whose own contract is to validate "untrusted input crossing the WS boundary" — it is an adversarial-input-triggerable corruption bug, not just an internal-consistency bug, and directly relevant to a security review.

### Detection
No test in `packages/protocol` or `packages/crdt` sends an oversized/adversarial counter value. Would require a fuzz/property test targeting the wire boundary.

### Prevention
Add `.max(Number.MAX_SAFE_INTEGER / 2)` (or a much tighter, realistic bound) to `opIdSchema.counter` in `packages/protocol/src/op.ts`, and have `Rga.apply()` reject/clamp/log on out-of-range counters instead of blindly adopting them via `Math.max`.

### Fix
Schema-level bound + defensive check in `apply()`/`integrate()` that refuses to overwrite an existing `nodesById` entry with a different node for the same key (log + drop instead).

### Severity
Critical

### Confidence
High — empirically reproduced.

### References
`packages/protocol/src/op.ts:5`; `packages/crdt/src/rga.ts:86, 201-204, 239-265`.

---

## 5. `opIdFromString` is not the inverse of `opIdToString` when `replicaId` contains "@"

### Root Cause
`opIdFromString` (`packages/crdt/src/opId.ts:17-27`) uses `serialized.lastIndexOf("@")` to find the delimiter, but since `counter` is always pure digits, the delimiter must be the *first* `@`, not the last. `replicaId` (`packages/protocol/src/messages.ts:6`) has no character restriction, so a client can legally choose a replicaId containing `@`.

### Trigger
Any replicaId containing an `@` character, e.g. `"evil@evil"`.

### Production Scenario
Empirically confirmed: `opIdToString({counter:5, replicaId:"evil@evil"})` → `"5@evil@evil"` → round-tripped through `opIdFromString` → `{counter: NaN, replicaId: "evil"}`. The counter becomes `NaN`; `replicaId` is truncated.

### User Impact
Any downstream consumer (server/persistence code using this exported function for string-keyed storage or map lookups) would silently break id lookups for that replica. `NaN` also breaks `compareOpId`'s strict total order (`NaN - x` is always `NaN`, so both `>0` and `<0` checks evaluate false), which `integrate()`'s ordering scan depends on for correctness.

### Business Impact
Low-probability but high-severity if a client (buggy or adversarial) ever picks such a replicaId — the blast radius is id-lookup corruption anywhere this function is used outside the audited scope.

### Detection
No round-trip property test (`opIdToString(opIdFromString(x)) === x` for arbitrary strings) exists.

### Prevention
Either restrict `replicaId`'s character set in the protocol schema (disallow `@`), or fix `opIdFromString` to use `indexOf` instead of `lastIndexOf`.

### Fix
One-line fix: `serialized.indexOf("@")` instead of `lastIndexOf`. Add a round-trip property test.

### Severity
Medium

### Confidence
High — empirically reproduced.

### References
`packages/crdt/src/opId.ts:17-27`; `packages/protocol/src/messages.ts:6`.

---

## 6. `localDelete` throws on a stale/out-of-range index during concurrent editing

### Root Cause
`localDelete(index)` (`packages/crdt/src/rga.ts:59-66`) calls `findNodeAtPosition(index)` and throws a generic `Error` if it returns `null` — i.e., if the index is no longer valid.

### Trigger
Classic optimistic-UI race: a caller computes a delete index from the locally observed document, but a remote delete (applied independently via `apply()`) shrinks the document between index computation and the `localDelete` call.

### Production Scenario
On the web client, this is directly reachable: `deltaToEdits.ts` converts a Quill `text-change` event into `localDelete` calls inside `Editor.tsx`'s change handler with no surrounding try/catch and no React error boundary anywhere in the app (see EDGE_CASES §6/§9 for the compounding astral-character variant, and [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) for the missing-error-boundary consequence).

### User Impact
An uncaught synchronous exception during a keystroke handler can crash the editor UI to Next.js's bare default error screen, losing the in-progress edit session view (though IndexedDB-persisted state may survive a reload, modulo the IndexedDB error-handling gaps in PRODUCTION_FAILURES §9).

### Business Impact
This directly hits the core editing interaction under exactly the condition (concurrent remote edits landing during local typing) that a *collaborative* editor is supposed to handle gracefully.

### Detection
Not covered by any test — would require a test that interleaves a remote delete with a stale local delete index.

### Prevention
`localDelete` should not throw on a stale index — it should either no-op (the target is already effectively gone) or return a sentinel indicating no-op, letting callers avoid needing a try/catch on every call.

### Fix
Change `localDelete` to return `null`/`undefined` on an out-of-range index instead of throwing, and update callers accordingly. Independently, add a React error boundary on the editor tree regardless (defense in depth).

### Severity
Medium

### Confidence
Medium — the throw itself is confirmed by direct code reading; real-world reachability depends on caller behavior, partially confirmed via the web client's `Editor.tsx` integration.

### References
`packages/crdt/src/rga.ts:59-66`.

---

## 7. Emoji / astral-plane characters corrupt deletes and misplace inserts

### Root Cause
`deltaToEdits.ts` (`apps/web/src/lib/deltaToEdits.ts:33-56`) splits `op.insert` using `for...of` (Unicode **code-point** iteration, correct), but `op.retain` and `op.delete` are raw counts supplied by `quill-delta`, which measures op length as `op.insert.length` — verified against `quill-delta`'s own source (`node_modules/quill-delta/src/Op.ts:21`) — i.e. **UTF-16 code units**. For any character outside the Basic Multilingual Plane (most emoji, some CJK extensions, mathematical symbols), the RGA's node-count position space (1 node per code point) and Quill's retain/delete counts (2 units per astral character) diverge permanently from that point in the document onward.

### Trigger
A user types or pastes an emoji (or other astral-plane character), then performs any subsequent retain-based operation (typing further, or deleting) that crosses that character.

### Production Scenario
- **Delete case (data loss):** backspacing over one emoji produces `delete: 2` in the Quill delta. `deltaToEdits` emits two `delete` edits at the same index — the first correctly tombstones the emoji's single RGA node, the second then deletes whatever unrelated character now occupies that position.
- **Insert/crash case:** any retain that runs past an astral character overcounts by 1 relative to the RGA's actual node count. `findNodeAtPosition` returns `null` past the end, so `localInsert` treats it as `anchor=null` and silently inserts at the document start (misplacement), while `localDelete` **throws** (compounding EDGE_CASES §6) synchronously inside an uncaught `text-change` handler with no error boundary anywhere in the app.

### User Impact
Typing or receiving a message containing any emoji and then continuing to edit near it can delete the wrong character or crash the editor for that user.

### Business Impact
Emoji are extremely common in real-world text; this is not an exotic input, it's a near-guaranteed occurrence in production usage.

### Detection
`deltaToEdits.test.ts` has no test case with any non-BMP character — untested today.

### Prevention
Convert Quill's UTF-16-unit-based retain/delete counts into code-point counts before translating to RGA edits (iterate the *current* document's code points to map UTF-16 offsets to code-point offsets), or switch the RGA to operate directly on UTF-16 code units to match Quill's native unit (trading off the multi-character-node problem in EDGE_CASES §2 differently).

### Fix
Add a UTF-16-offset → code-point-offset translation layer in `deltaToEdits.ts` using the client's current document text as the mapping source, with an explicit test matrix covering emoji, combining characters, and surrogate pairs at delete/retain boundaries.

### Severity
High

### Confidence
High — verified against actual `quill-delta` source and this repo's `Rga` position logic.

### References
`apps/web/src/lib/deltaToEdits.ts:33-56`; `packages/crdt/src/rga.ts:267-284`, `:59-66`; `node_modules/quill-delta/src/Op.ts:21`.

---

## 8. Presence "ghost cursors" never expire on the client

### Root Cause
`documentClient.ts` (`apps/web/src/lib/documentClient.ts:226-241`) fully trusts the server to eventually emit a `presence-leave` message; there is no client-side TTL/staleness check on presence entries. `HEARTBEAT_INTERVAL_MS` (8000ms) is used only to *send* this client's own presence, never to expire *others'*.

### Trigger
A peer's connection drops without a clean WS close (crash, network cut, server-side bug or restart that loses session/presence state) such that the server never broadcasts `presence-leave` for that peer.

### Production Scenario
The disconnected peer's cursor and name remain visible in `PresenceList` indefinitely for every other connected client, with no local timeout to prune it.

### User Impact
Users see phantom collaborators who are no longer present, which is confusing and erodes trust in the presence feature specifically.

### Business Impact
Low severity but a visible, easily-noticed UX defect in a headline collaborative-editing feature (seeing who's currently editing).

### Detection
No client-side test exercises this (would require simulating a server that stops sending presence-leave).

### Prevention
Add a client-side staleness timeout (e.g., prune any presence entry whose last-seen heartbeat exceeds ~3x the heartbeat interval), independent of server-side cleanup correctness.

### Fix
Track `lastSeen` per presence entry on the client and prune stale entries on an interval or on render.

### Severity
Medium

### Confidence
Medium — client-side behavior confirmed directly; whether the server reliably handles every disconnect path was out of this scope.

### References
`apps/web/src/lib/documentClient.ts:226-241`; `apps/web/src/components/PresenceList.tsx:23-28`.

---

## 9. IndexedDB schema has no version-upgrade path

### Root Cause
`db.ts`'s `upgrade()` callback (`apps/web/src/lib/db.ts:40-57`) unconditionally calls `createObjectStore` for all three stores. This only works because `DB_VERSION` has never been bumped past `1` — `createObjectStore` throws if a store of that name already exists.

### Trigger
Any future change to the IndexedDB schema that requires bumping `DB_VERSION`.

### Production Scenario
The day the schema changes, whoever bumps `DB_VERSION` must remember to branch on `event.oldVersion` inside `upgrade()` — there is no existing pattern in this file to follow and no test guarding it. Without that branching, every existing user's browser throws on the next schema migration attempt.

### User Impact
Not yet triggered (dormant defect) — but when it is, affected users would see their local IndexedDB open fail, compounding into the "infinite Loading…" failure mode described in [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §9.

### Business Impact
Deferred risk — becomes real the moment the schema needs to evolve, which is a near-certainty over the product's lifetime.

### Detection
No test simulates an `oldVersion` upgrade path.

### Prevention
Write the `upgrade()` callback defensively now (branch on `event.oldVersion`, guard each `createObjectStore` call with an existence check) even though it's a no-op today, so the pattern exists before it's needed.

### Fix
```ts
upgrade(db, oldVersion) {
  if (oldVersion < 1) { /* create v1 stores */ }
  // if (oldVersion < 2) { /* future migration */ }
}
```

### Severity
Low-Medium

### Confidence
High.

### References
`apps/web/src/lib/db.ts:40-57`.

---

## 10. `seq` column is a 32-bit integer fed by an unbounded Redis `INCR`

### Root Cause
`Operation.seq` and `Document.latestSeq` are Prisma `Int` (Postgres 32-bit `INTEGER`, max 2,147,483,647) (`packages/database/prisma/schema.prisma:24-25, :15`), but `RedisSeqAllocator.next()` calls `this.redis.incr(seqKey(docId))` (`apps/server/src/seq/RedisSeqAllocator.ts:15-17`), which operates on Redis's 64-bit signed integers and never errors as it approaches 2^31. Unlike `Operation.id`, which was correctly upgraded to `BigInt`, `seq` was not.

### Trigger
A single document accumulating more than ~2.1 billion op-batches over its lifetime.

### Production Scenario
A long-lived, heavily-edited document — or one targeted by a buggy looping client or deliberate abuse (no rate limiting exists anywhere in the app, see [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md)) — eventually has `seq` values that no longer fit in Postgres's `INTEGER` column. Every subsequent write for that document starts failing with a Postgres "integer out of range" error, and there is no code path in `PrismaPersistenceStore.appendOps` handling that error class specifically.

### User Impact
Once triggered, the affected document becomes permanently unwritable through the current schema.

### Business Impact
Low near-term likelihood for casual use, but realistic for any single popular/pinned document under sustained heavy collaborative use over a long product lifetime, or trivially reachable by an attacker deliberately flooding one `docId` (compounds with the missing rate-limiting and missing auth findings).

### Detection
No test exercises `seq` values anywhere near the int32 boundary.

### Prevention
Change `Operation.seq` and `Document.latestSeq` to `BigInt` in the Prisma schema (matching `Operation.id`'s existing precedent), with a migration.

### Fix
Prisma schema change + migration: `seq BigInt`, `latestSeq BigInt`. Low-risk, high-value fix given the precedent already exists in the same schema.

### Severity
Medium

### Confidence
High.

### References
`packages/database/prisma/schema.prisma:15, 24-25`; `apps/server/src/seq/RedisSeqAllocator.ts:15-17`.

---

## 11. `replicaId` collision silently evicts an existing connection

### Root Cause
`Room.join(replicaId, socket)` (`apps/server/src/room.ts:55-57`) does `this.sockets.set(replicaId, socket)` with no check for an existing entry. Since `replicaId` is entirely client-supplied and unauthenticated (see [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §2), any second connection reusing an already-active `replicaId` silently overwrites the map entry.

### Trigger
Two connections joining the same room with the same `replicaId` — plausible from the same legitimate user opening two tabs, or a client reconnect racing its own stale connection's teardown, or deliberately by an adversarial client.

### Production Scenario
The original socket stays open (not closed, no error) but silently stops receiving any further broadcasts — the user just sees their collaborators' edits stop appearing, with zero indication anything went wrong.

### User Impact
Silent desync: one of the user's tabs/sessions goes stale with no error message, indistinguishable from "nothing is happening" rather than a reportable bug.

### Business Impact
Combined with the total absence of authentication, this is also a session-hijack-adjacent vector: any client that learns or guesses another active replicaId can silently evict that connection from receiving updates.

### Detection
No test covers duplicate-replicaId join behavior.

### Prevention
On a `replicaId` collision, either reject the new join, or proactively close the old socket with a clear reason code (e.g., "replaced by newer connection") so the evicted client can react (show a UI message, reconnect with a new id).

### Fix
Check `this.sockets.has(replicaId)` in `join()` and close the prior socket with an explicit close code before replacing the map entry.

### Severity
High (severity elevated by the lack of authentication — see [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §2)

### Confidence
High.

### References
`apps/server/src/room.ts:55-57`.

---

## 12. Weak `Math.random()` fallback for replica-id generation

### Root Cause
```ts
function defaultReplicaId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
```

### Trigger
Any runtime/deployment context lacking `crypto.randomUUID` — browsers require a secure context (HTTPS) for it; some older or restricted runtimes lack it entirely.

### Production Scenario
A dev/test environment or a misconfigured non-HTTPS deployment silently drops to `Math.random()`-derived ids: non-cryptographic, roughly 6 base36 characters of entropy after `.slice(2)`, with no collision-resistance guarantee.

### User Impact
A replicaId collision between two concurrently active replicas defeats `compareOpId`'s tie-break and reproduces the same id-collision corruption class as EDGE_CASES §4 and §13 (wrong node addressed/deleted).

### Business Impact
Low-medium — depends on deployment specifics (HTTPS is standard for production web apps), but a real gap for any non-browser client or degraded environment.

### Detection
Not tested — no test forces the `Math.random()` fallback path.

### Prevention
Use a stronger fallback (e.g., a manually-assembled UUID from `crypto.getRandomValues` where available, or reject startup entirely if no secure random source exists) rather than silently degrading to `Math.random()`.

### Fix
Replace the fallback with an explicit error or a `crypto.getRandomValues`-based UUID polyfill; never silently fall back to `Math.random()` for an identifier used as a correctness-critical uniqueness key.

### Severity
Low-Medium

### Confidence
Medium — depends on deployment/runtime specifics outside this audit's direct verification.

### References
`packages/crdt/src/rga.ts:19-24`.

---

## 13. No uniqueness enforcement on snapshot node ids

### Root Cause
`snapshotMessageSchema.state` (`packages/protocol/src/messages.ts:65-70`) is `z.array(rgaSnapshotNodeSchema)` with no `.refine()` for id-uniqueness. `Rga.fromSnapshot` (`packages/crdt/src/rga.ts:163-187`) links every array entry into the list and does an unconditional `nodesById.set(...)` per entry.

### Trigger
A snapshot payload (server bug, compromised server, or storage-layer corruption) containing two entries with the same `id`.

### Production Scenario
Two list nodes end up sharing one id; only one is reachable via `nodesById` (whichever entry is later in the array wins the map slot). A subsequent delete targeting that id hits the wrong node — the same corruption class as EDGE_CASES §4, but reachable via snapshot loading rather than counter overflow.

### User Impact
Same as §4: a delete silently removes different content than intended.

### Business Impact
Medium — requires a corrupted/malicious snapshot to trigger, a smaller attack surface than §4's direct wire-message path, but the *server itself* produces and serves snapshots, so a server-side bug alone (not necessarily an external attacker) is sufficient to trigger this.

### Detection
No test constructs a snapshot with duplicate ids.

### Prevention
Add a `.refine()` uniqueness check to `snapshotMessageSchema.state`, and/or have `fromSnapshot` reject or warn on duplicate ids instead of silently overwriting.

### Fix
Schema-level `.refine()` for id uniqueness; defensive check in `fromSnapshot`.

### Severity
Medium

### Confidence
Medium — not independently re-verified at runtime in this audit, but mechanically identical to the empirically-confirmed pattern in EDGE_CASES §4.

### References
`packages/protocol/src/messages.ts:65-70`; `packages/protocol/src/rgaSnapshot.ts:5-11`; `packages/crdt/src/rga.ts:163-187`.

---

## 14. Landing-page search input has no accessible label

### Root Cause
```tsx
<input
  value={slugInput}
  onChange={(event) => setSlugInput(event.target.value)}
  placeholder="or enter an existing document id"
/>
```
Relies solely on `placeholder` text, with no `<label>`, `aria-label`, or `aria-labelledby`.

### Trigger
Any screen-reader user, or any user relying on browser autofill/form-field identification, visiting the landing page.

### Production Scenario
Screen readers announce no persistent label for the field once content is entered (placeholder text is not read as a label by most assistive tech in that state), and the placeholder visually disappears on focus — a known WCAG 1.3.1 / 3.3.2 anti-pattern.

### User Impact
Accessibility barrier for screen-reader users on the app's primary entry point.

### Business Impact
Low direct business impact but a straightforward, cheap accessibility compliance gap.

### Detection
No accessibility test/lint (e.g., `eslint-plugin-jsx-a11y`) is configured to catch this — confirmed via `apps/web/eslint.config.mjs`.

### Prevention
Add `aria-label` or a visually-hidden `<label>` to every form input; consider adding `eslint-plugin-jsx-a11y` to the lint config to catch regressions.

### Fix
```tsx
<label htmlFor="doc-slug" className="sr-only">Document ID</label>
<input id="doc-slug" aria-label="Enter an existing document id" ... />
```

### Severity
Low

### Confidence
High.

### References
`apps/web/src/app/page.tsx:30-34`.

---

## 15. Brief "flash of empty document" on load before client init resolves

### Root Cause
`useDocument`'s effect synchronously constructs `new DocumentClient(...)` and calls `setClient(instance)` before the client's async `init()` (IndexedDB load + WS connect) resolves — `client` becomes non-null (mounting `Editor`) while `this.rga` is still a placeholder empty `Rga`.

### Trigger
Every page load / document open, universally.

### Production Scenario
`Editor.tsx`'s one-time `quill.setContents(...)` can run against the still-empty placeholder before `init()`'s `notify()` fires; the editor briefly renders as empty, then the real content pops in once the subscribe-based diff-sync applies it.

### User Impact
A visible, momentary flash of an empty editor on every load — self-healing, not data-lossy, but a perceived-performance/polish issue.

### Business Impact
Low — cosmetic, but a first-impression issue on every single document open.

### Detection
Would require a visual regression test or a timing-sensitive integration test; not currently covered.

### Prevention
Show an explicit loading skeleton/spinner state until `init()` resolves, rather than mounting the editor against empty placeholder content.

### Fix
Gate `Editor` mounting on an explicit `isReady` flag from `DocumentClient` rather than on `client !== null`.

### Severity
Low

### Confidence
Medium.

### References
`apps/web/src/lib/documentClient.ts:85-114`; `apps/web/src/components/Editor.tsx:36-38, 56-63`.

---

## Test Coverage Gaps (meta-finding)

The following are not individually reproduced bugs but structural gaps in the test suites that mean several of the above findings (and unknown others of the same class) would not be caught by CI today:

- **No unicode/emoji/combining-character/RTL test anywhere** in `packages/crdt` or `packages/protocol` — every test alphabet is ASCII-only (`"abcde"`).
- **No test with multi-character `value`** in `localInsert` (masks §2).
- **No test combining `attrs` with concurrent/interleaved edits, nesting, or marker deletion** (masks §3).
- Only one explicit 2-way same-anchor concurrent-insert test (`rga.test.ts:144-162`); no targeted 3+-way same-anchor test with assertions.
- Insert-duplicate idempotency is tested (`rga.test.ts:106-115`); delete-duplicate idempotency is not.
- Causal buffering is tested only one dependency hop deep (`rga.test.ts:117-142`) — no 3+-link out-of-order delivery chain test.
- **`packages/protocol` has zero property-based/fuzz tests** — `fast-check` is a dependency of `packages/crdt` only, not `packages/protocol`.
- No test for oversized payloads, overflowing op-id counters, or duplicate ids in a snapshot array (masks §4, §13, and the DoS finding in [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md)).
- `deltaToEdits.test.ts` has no non-BMP character case (masks §7).
- `packages/database` has zero automated tests at all (see [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md)).

**Severity:** Medium (structural). **Confidence:** High.
