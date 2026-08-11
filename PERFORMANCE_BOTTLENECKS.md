# PERFORMANCE_BOTTLENECKS.md — YSync Production Audit

Scope: `packages/crdt`, `packages/protocol`, `apps/server`, `apps/web`, `packages/database`. Every finding is grounded in code actually read during this audit; no benchmark numbers are invented — where the repo's own `scripts/loadTest.ts`/`scripts/storageGrowthBenchmark.ts` provide real measurements, they're cited; otherwise impact is described qualitatively (algorithmic complexity, resource growth pattern) rather than with a fabricated number.

Related documents: [EDGE_CASES.md](EDGE_CASES.md), [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md), [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md).

---

## 1. Tombstones are never garbage-collected — every operation degrades toward O(total lifetime ops)

**Current implementation:** `Rga.compactTombstones()` (`packages/crdt/src/rga.ts:190-199`) only clears a tombstoned node's `value`/`attrs` payload — the node object, its `next` link, and its `nodesById` map entry are retained forever. `findNodeAtPosition`, `integrate()`'s right-scan, `read()`, and `getContentsForEditor()` all walk the full linked list from `head`.

```ts
compactTombstones(): void {
  let node = this.head;
  while (node !== null) {
    if (node.tombstone) {
      node.value = null;
      node.attrs = undefined;
    }
    node = node.next;
  }
}
```

**Why it bottlenecks:** List traversal cost is proportional to the total number of insert ops ever applied to a document (visible + tombstoned), not to the currently-visible character count. `nodesById` (a `Map`) also never shrinks, so memory grows monotonically with lifetime op count regardless of current document size.

**Evidence:** Direct code reading of `rga.ts` — no list-splicing/unlinking logic exists anywhere in the file for tombstoned nodes. `apps/server/scripts/storageGrowthBenchmark.ts` measures storage-row growth under repeated edit churn but does not measure in-memory RGA traversal cost specifically, so this exact cost curve is not independently benchmarked in the repo today (a real gap in the project's own tooling — see item 9 below).

**Expected impact:** For a long-lived, heavily-edited document (months of collaborative editing with type-delete-retype cycles, which is normal collaborative-editor usage), every keystroke's `localInsert`/`localDelete` (via `findNodeAtPosition`) walks a list that keeps growing even though the visible character count stays roughly constant — an editing session's total cost trends toward O(n²) in cumulative ops.

**Scaling limit:** No hard limit — this is unbounded growth, not a threshold. Practically, a document that has accumulated, say, hundreds of thousands of edit-and-delete cycles over its lifetime would show materially slower per-keystroke latency and materially higher server memory footprint per open room than a fresh document of the same visible size, even though nothing about the *visible* document changed.

**Suggested optimization:** Implement real tombstone garbage collection — periodically splice out and unlink tombstoned nodes once no causal dependency can reference them anymore (standard RGA/CRDT GC requires a "causal stability" check: a tombstone is safe to physically remove once every replica has acknowledged having seen it, or after a configurable retention window if strict causal-stability tracking is out of scope for v1).

**Estimated improvement:** Converts per-operation cost from O(lifetime ops) to O(visible document size) — the standard, expected complexity class for this data structure. No specific percentage is claimed without a benchmark; the qualitative change (unbounded → bounded growth) is the material fix.

**Confidence:** High (algorithmic analysis directly from code).

**References:** `packages/crdt/src/rga.ts:104-114, 190-199, 239-284`.

---

## 2. No size bounds anywhere in the wire protocol — unbounded messages inflate memory, bandwidth, and DB row size

**Current implementation:** `packages/protocol/src/messages.ts` and `op.ts` define zero `.max()` constraints: `ops: z.array(opSchema).min(1)` has no upper bound, `value: z.string()` on `InsertOp` has no length cap, `formatMarkSchema = z.record(...)` has no key-count cap. `packages/database/prisma/schema.prisma`'s `Operation.value` is an unbounded Postgres `TEXT` column and `Snapshot.state` an unbounded `Json`/`JSONB` column.

**Why it bottlenecks:** Every layer — WS message parsing (synchronous `JSON.parse` on the Node event loop, see `apps/server/src/server.ts:45`), in-memory `Rga` buffering (`pending` map, see item 3), and Postgres row/JSONB storage — has to accommodate whatever size a client sends, with no backstop.

**Evidence:** Confirmed via direct grep across `packages/protocol/src` — zero `.max(` calls anywhere in the schema files. Independently corroborated by the project's own (untracked, gitignored) `DEPLOYMENT.md`, which explicitly states rate limiting "is not implemented in the code" and flags unthrottled op/presence flooding as "a real pre-launch gap" (self-documented by the project authors).

**Expected impact:** A single WS message can carry an arbitrarily large `ops` array, each with an arbitrarily large `value` string, parsed synchronously (blocking the event loop for the duration of `JSON.parse` and Zod validation) and then persisted as unbounded `TEXT`/`JSONB` rows.

**Scaling limit:** No enforced limit exists today, so the practical limit is whatever the `ws` library's default `maxPayload` allows (unconfigured in `server.ts:39`, meaning the library default of ~100 MiB applies) combined however much heap/DB space is available before the process or database degrades.

**Suggested optimization:** Add `.max()` bounds at every layer: WS `maxPayload` configured explicitly (not left at library default), Zod schema caps on array length, string length, and record key count, and a request-level rate limiter (token bucket per connection/IP) ahead of the parse step.

**Estimated improvement:** Converts an unbounded-input attack/bug surface into a bounded, predictable one — this is a correctness/DoS-prevention fix as much as a performance one (see [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) for the DoS framing of the same gap).

**Confidence:** High.

**References:** `packages/protocol/src/messages.ts`, `packages/protocol/src/op.ts:16`; `packages/database/prisma/schema.prisma:28` (Operation.value), Snapshot.state; `apps/server/src/server.ts:39, 45`.

---

## 3. Unbounded `pending` op buffer on causal-dependency stalls

**Current implementation:** `Rga.apply()` (`packages/crdt/src/rga.ts:79-82, 206-213`) buffers any op whose `originId` doesn't yet resolve into `this.pending`, a `Map` with no cap, no TTL, and no eviction policy.

**Why it bottlenecks:** Combined with item 2's unbounded message sizes, a client can trivially and cheaply produce ops that reference fabricated, never-arriving `originId`s. Each is pushed into `pending` and stays there permanently.

**Evidence:** Empirically confirmed during this audit — a test loop applying 1000 ops each with a random non-existent `originId` produced `pending.size === 1000` with `read()` returning empty content and no error surfaced anywhere.

**Expected impact:** Unbounded heap growth per room proportional to however many dependency-stalled ops a client (buggy or malicious) chooses to send — cheap to trigger, expensive to hold.

**Scaling limit:** Bounded only by process memory; there's no internal cap that would fail gracefully before an OOM.

**Suggested optimization:** Cap `pending` size per room (with the room rejecting/dropping further buffered ops past the cap, or forcing a resync), and add a TTL so stalled ops eventually get discarded and logged rather than held forever.

**Estimated improvement:** Converts unbounded per-room memory growth into a bounded, capped footprint.

**Confidence:** High (empirically confirmed).

**References:** `packages/crdt/src/rga.ts:39, 79-82, 206-213`.

---

## 4. No backpressure handling on WebSocket sends — slow readers can exhaust server memory

**Current implementation:** `Room.sendTo`/`Room.broadcast` (`apps/server/src/room.ts:107-120`) call `socket.send(payload)` unconditionally for every socket in the `OPEN` state, never checking `socket.bufferedAmount` or providing a send callback to detect backpressure/errors.

**Why it bottlenecks:** A slow consumer (mobile client on a poor connection, or a client that's simply stopped reading) accumulates unbounded buffered writes in the underlying `ws` library's internal queue, with no cap, no drop policy, and no disconnect-on-lag logic.

**Evidence:** Direct code reading — no `bufferedAmount` check, no send-callback error handling, anywhere in `room.ts`. `new WebSocketServer({ server: httpServer })` (`server.ts:39`) sets no `maxPayload` either, leaving the `ws` library default in effect.

**Expected impact:** In a room with many participants, one slow reader's growing send buffer consumes server-side memory proportional to how far behind it falls, with no ceiling.

**Scaling limit:** Bounded only by process memory across however many slow/stalled connections accumulate simultaneously — worse in a room with high edit frequency and many participants (broadcast fan-out multiplies the effect).

**Suggested optimization:** Check `socket.bufferedAmount` before sending (or use `ws`'s send callback to track outstanding bytes); when a socket's buffer exceeds a threshold, either drop non-critical messages (e.g., presence updates) or forcibly disconnect the lagging client and have it resync via `sinceSeq` on reconnect (the client already supports this resume path per the audit of `documentClient.ts`).

**Estimated improvement:** Converts unbounded per-slow-connection memory growth into a bounded, self-healing pattern (slow clients get disconnected and resync rather than accumulating server memory indefinitely).

**Confidence:** High.

**References:** `apps/server/src/room.ts:107-120`; `apps/server/src/server.ts:39, 45`.

---

## 5. Unstaggered per-room sweep timers create synchronized load spikes on Redis/Postgres

**Current implementation:** Every `Room` gets its own independent `setInterval(sweepIntervalMs)` (`apps/server/src/roomManager.ts:91-93`), starting from room-creation time, running presence sweeps and (conditionally) snapshot writes.

**Why it bottlenecks:** Rooms created in a burst (e.g., mass reconnection after a deploy or failover) have their timers fire in near lockstep, producing periodic load spikes against Redis (`presenceStore.sweep`) and potentially Postgres (`writeSnapshot`) proportional to the number of simultaneously active rooms, rather than smoothly distributed load over time.

**Evidence:** Direct code reading of `roomManager.ts:91-93` — no jitter/stagger is applied to timer start times.

**Expected impact:** Under normal steady-state usage this is invisible; it becomes visible precisely during the highest-load moment — a mass-reconnect event, which is also when the system is least able to absorb a load spike.

**Scaling limit:** Grows with the number of concurrently active rooms created within a short window of each other.

**Suggested optimization:** Add random jitter to each room's initial sweep delay (e.g., `sweepIntervalMs * Math.random()` for the first tick, then regular interval thereafter), so sweep load smooths out across the interval window instead of clustering.

**Estimated improvement:** Converts a periodic load spike proportional to concurrently-created-room count into steady, smoothed background load.

**Confidence:** Medium.

**References:** `apps/server/src/roomManager.ts:91-93`.

---

## 6. Snapshot threshold checked only once per sweep tick — bursty documents overshoot the intended cap

**Current implementation:**
```ts
if (entry.room.getOpsSinceSnapshot() >= this.snapshotOpThreshold) {
  await this.snapshotRoom(docId);
}
```
This check only runs inside `tick()`, gated by `sweepIntervalMs` (default 10s per the audit) — there is no synchronous/inline check inside `applyClientOp` itself.

**Why it bottlenecks:** A single very hot document can accumulate far more than `snapshotOpThreshold` (default 50, per the audit of `roomManager.ts:79`) ops in `Room.opLog` between ticks, meaning `opLog` (an in-memory array, replayed on every load/rehydrate until the next snapshot) can grow well past its intended bound during a throughput spike.

**Evidence:** Direct code reading of `roomManager.ts:234, 245-247, :79`.

**Expected impact:** The larger the burst between sweep ticks, the larger `opLog` grows before being trimmed by the next snapshot — increasing both in-memory footprint and the cost of any rehydration that happens to occur before the next tick fires.

**Scaling limit:** Proportional to burst throughput × `sweepIntervalMs` — a document sustaining, say, 200 ops/sec for the full 10-second tick window would accumulate ~2000 ops in `opLog` before the threshold check catches up, 40x the configured threshold.

**Suggested optimization:** Add an inline check inside `applyClientOp` (or `Room.applyOps`) that triggers a snapshot as soon as `opsSinceSnapshot` crosses the threshold, rather than waiting for the next sweep tick.

**Estimated improvement:** Bounds `opLog` growth to the configured threshold regardless of burst intensity, rather than to threshold × however many ops arrive within one sweep interval.

**Confidence:** Medium.

**References:** `apps/server/src/roomManager.ts:79, 234, 245-247`.

---

## 7. No Postgres connection pooling configured — horizontal scaling multiplies direct connections

**Current implementation:** `packages/database/src/client.ts:9-12` constructs `new PrismaPg({ connectionString: databaseUrl })` with no `max`/pool options set. `PrismaPg` wraps `pg.Pool`, which defaults to `max: 10` connections when unconfigured (verified against `@prisma/adapter-pg`'s type definitions and Prisma's own documentation — Prisma ORM v7's driver-adapter model sources pooling config from the underlying driver, not from `connection_limit` query-string params, which only applied to the older Rust query engine).

**Why it bottlenecks:** The system's own design (per `docs/` phase changelogs) targets horizontal scaling of `apps/server` across multiple processes coordinated via Redis pub/sub. Each process instantiates its own `PrismaPersistenceStore`, hence its own independent 10-connection pool. N server instances therefore open up to N×10 direct Postgres connections, with no PgBouncer, Prisma Accelerate, or provider-side pooled endpoint configured anywhere in `docker-compose.yml`, `.env.example`, or the project's (gitignored) deployment docs.

**Evidence:** `packages/database/src/client.ts:9-12`; confirmed default via `@prisma/adapter-pg`'s wrapping of `pg.Pool`; corroborated by the multi-instance horizontal-scaling design documented in `docs/changes/phase-3-server-core.md` and exercised by `apps/server/test/roomManager.multiInstance.test.ts`.

**Expected impact:** A modest horizontal scale-out (e.g., 10+ server instances during a traffic spike or autoscale event) can approach or exceed the connection cap of a typical managed Postgres tier (e.g., Neon's free/starter tiers commonly cap well under 100 total connections).

**Scaling limit:** Roughly `(max pool size per instance) × (instance count)` against whatever the Postgres provider's connection cap is — this is a hard ceiling past which new connections are refused, causing write failures across the fleet, not just degraded latency.

**Suggested optimization:** Front Postgres with a connection pooler (PgBouncer in transaction-pooling mode, or a managed equivalent like Neon's pooled connection string / Prisma Accelerate), and explicitly configure `pg.Pool`'s `max` per instance to a value that, multiplied by expected max instance count, stays comfortably under the provider's cap.

**Estimated improvement:** Removes a hard connection-count ceiling on horizontal scaling; without it, scaling `apps/server` out is capped not by CPU/memory but by an unrelated, easy-to-hit database connection limit.

**Confidence:** High (pool default and multi-instance design both confirmed); Medium on the specific provider connection-cap number, since that's provider/tier-dependent and wasn't independently verified against a specific account.

**References:** `packages/database/src/client.ts:9-12`; `docs/changes/phase-3-server-core.md`; `apps/server/test/roomManager.multiInstance.test.ts`.

---

## 8. WebSocket reconnect backoff has no jitter — thundering herd on server restart

**Current implementation:**
```ts
private scheduleReconnect(): void {
  if (this.reconnectTimer) return;
  const delay = Math.min(500 * 2 ** this.reconnectAttempt, MAX_RECONNECT_DELAY_MS);
  this.reconnectAttempt += 1;
  this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
}
```

**Why it bottlenecks:** Backoff is a pure deterministic function of `reconnectAttempt` (500ms, 1s, 2s, 4s, 8s, capped at `MAX_RECONNECT_DELAY_MS`) with no randomization. When the server restarts or redeploys, every connected client's socket closes at roughly the same wall-clock moment, so every client computes the identical delay sequence and reconnects in near lock-step.

**Evidence:** Direct code reading of `apps/web/src/lib/documentClient.ts:144-152`.

**Expected impact:** A deploy or restart event — already a moment of reduced capacity while the new instance(s) warm up — is met with a synchronized wave of reconnect attempts from every previously-connected client, each also re-triggering a `sync`/catch-up exchange and outbox flush against the server, compounding load right when the system is least able to absorb it.

**Scaling limit:** Proportional to the number of clients connected at the moment of restart — the larger the concurrent user base, the sharper the reconnect spike.

**Suggested optimization:** Add randomized jitter to the backoff calculation (e.g., `delay * (0.5 + Math.random() * 0.5)`), a standard mitigation for exactly this failure mode.

**Estimated improvement:** Spreads a synchronized reconnect spike into a smoothed distribution over the jitter window, reducing peak load on the server immediately post-restart without changing total reconnect volume.

**Confidence:** High.

**References:** `apps/web/src/lib/documentClient.ts:144-152`.

---

## 9. Load test and storage-growth benchmark don't measure the scaling axes the architecture actually depends on

**Current implementation:** `apps/server/scripts/loadTest.ts:31-33, 95-163` targets a single hot document (`LOAD_TEST_CLIENTS` default 60, `LOAD_TEST_ROUNDS` default 30, all against one `DOC_ID`). `apps/server/scripts/storageGrowthBenchmark.ts:25` hardcodes a `snapshotOpThreshold` of 500 in its comment/comparison, while the actual runtime default in `roomManager.ts:79` is 50 — the benchmark's own comment claims it "mirrors `RoomManagerOptions.snapshotOpThreshold`," which is no longer true.

**Why it bottlenecks (as a measurement gap, not a runtime one):** These scripts validate fan-out/broadcast latency for one busy room, but the architecture's actual risk surface — per items 5, 6, and 7 above — is the *many concurrent distinct rooms* axis (timer count, Redis subscription count, connection-pool pressure). Nothing in the repo currently exercises or measures that axis.

**Evidence:** Direct code reading of both scripts.

**Expected impact:** The project's documented/claimed performance characteristics (e.g., sub-20ms p95 broadcast latency) are real for the single-hot-room case they measure, but provide no evidence about behavior under the many-rooms scaling profile that the Redis-backed multi-instance architecture is specifically designed to support — that's an unmeasured, unvalidated claim.

**Scaling limit:** N/A — this is a tooling/measurement gap, not a runtime bottleneck.

**Suggested optimization:** Add a load-test mode that creates many concurrent distinct rooms (hundreds to thousands) with modest per-room activity, measuring memory, timer count, and Redis subscription count as room count scales. Fix the `storageGrowthBenchmark.ts:25` constant to match the actual runtime default (50) or make it read the real default programmatically so it can't drift again.

**Estimated improvement:** N/A (tooling gap) — closing it would surface whether items 5-7 above are theoretical or materially significant at realistic room counts, replacing qualitative analysis with real numbers.

**Confidence:** High.

**References:** `apps/server/scripts/loadTest.ts:31-33, 95-163`; `apps/server/scripts/storageGrowthBenchmark.ts:25`; `apps/server/src/roomManager.ts:79`.

---

## 10. No `CONCURRENTLY` convention documented for future index additions on a high-write table

**Current implementation:** The current migration's `CREATE INDEX`/`CREATE UNIQUE INDEX` statements (`packages/database/prisma/migrations/20260731131502_init/migration.sql:38, 41, 44`) run safely against empty tables today. But Prisma wraps multi-statement migrations in a transaction (confirmed against Prisma's documented migration behavior), and `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.

**Why it bottlenecks (as a future risk, not a current one):** Any future index added to the `Operation` table — which by then will be a high-write, high-row-count table — via a standard `prisma migrate dev`-generated migration will either lock the table for the duration of the index build (if `CONCURRENTLY` is omitted, the default) or fail outright (if `CONCURRENTLY` is added naively alongside Prisma's transaction wrapping).

**Evidence:** Direct reading of the migration SQL; Prisma's documented transactional-migration behavior confirmed via search.

**Expected impact:** Not yet triggered — the risk activates the first time a new index is added to `Operation` or `Snapshot` post-launch, at which point a naive migration could cause a write-blocking table lock in production for however long the index build takes on a populated table.

**Scaling limit:** Directly proportional to `Operation` table row count at the time such a migration is run — worse the longer the system has been live and accumulating rows.

**Suggested optimization:** Document this Prisma-specific constraint for future maintainers (e.g., in a `packages/database/README.md` or migration-authoring guide), and establish a convention of hand-editing generated migration SQL to move any future `CREATE INDEX` onto `CONCURRENTLY` outside Prisma's transaction wrapper when the target table is expected to be populated.

**Estimated improvement:** Prevents a future full-table write lock during what should be a routine schema change.

**Confidence:** High.

**References:** `packages/database/prisma/migrations/20260731131502_init/migration.sql:38, 41, 44`.
