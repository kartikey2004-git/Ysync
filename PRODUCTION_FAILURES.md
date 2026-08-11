# PRODUCTION_FAILURES.md — YSync Production Audit

Scope: `packages/crdt`, `packages/protocol`, `apps/server`, `apps/web`, `packages/database`, and repo-level infra/CI/CD. Every finding is grounded in code, config, or the project's own (untracked/gitignored) operational docs, all read directly during this audit. Findings are ordered by severity.

Related documents: [EDGE_CASES.md](EDGE_CASES.md), [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md), [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md).

---

## CRITICAL

### 1. Delete operations are silently dropped from durable storage — deleted text resurrects after restart

**Failure mode:** A delete op's dedup/identity key collides with the identity key of the insert it targets, so once the insert is persisted, the corresponding delete is treated as a duplicate and never written to durable storage.

```ts
// packages/crdt/src/op.ts:20-22
export function opIdOf(op: Op): OpId {
  return op.type === "insert" ? op.id : op.targetId;   // delete's identity == its TARGET's id
}
```
```ts
// apps/server/src/persistence/InMemoryPersistenceStore.ts (appendOps) — same bug class in PrismaPersistenceStore via skipDuplicates
for (const op of ops) {
  const opIdKey = opIdKeyOf(op);
  if (doc.seenOpIds.has(opIdKey)) continue;   // delete(targetId=A) has the same key as insert(A)
  doc.seenOpIds.add(opIdKey);
  doc.ops.push({ seq, op });
}
```
In Postgres, `PrismaPersistenceStore` uses `createMany({ skipDuplicates: true })` against the `@@unique([docId, opId])` constraint (`packages/database/prisma/schema.prisma:32`) — the same silent-skip behavior. **Confirmed directly against the current source during this audit** (not just agent-reported).

**Trigger:** Essentially every delete operation in normal use, since the insert that created a node almost always precedes its delete. This is not a rare edge case — it is close to the default path.

**Likelihood:** Certain, on the specific condition that the room's in-memory state is discarded and later rehydrated from persistence — server restart, a room evicted after its idle timeout and later rejoined, or a new/failover instance cold-hydrating a document.

**Blast radius:** Every document that has ever had a delete operation, once it goes through a rehydrate cycle. The live in-memory session is unaffected (deletes apply correctly against the in-memory RGA during a live session, since `Room.hydrate` and `RoomManager` bypass this dedup path for already-applied local state) — the corruption is dormant until the persisted op log is replayed.

**Recovery:** None automatic. Once a document has been rehydrated with the bug live, deleted text is back in the document and indistinguishable from intentional content — there's no log or flag marking which characters were "supposed to be" deleted.

**Mitigation:** Fix `opIdOf` so a delete's persistence identity is derived from something unique to the delete itself (e.g., a hash or composite of `targetId` plus an explicit delete-sequence discriminator, or simply not deduplicating deletes by the same key space as inserts). Requires a data migration/reconciliation pass for any already-deployed documents that have gone through a rehydrate cycle with this bug present.

**Detection:** No existing test would catch this — `test/roomManager.restart.test.ts` and `test/persistence.*.test.ts` only exercise inserts through the persistence round-trip; `test/offlineReconnect.scenario.test.ts` generates deletes but only inspects live in-memory state, never triggering a restart/rehydrate cycle.

**Monitoring:** Add an assertion/metric comparing "ops applied to live in-memory room" vs. "ops actually persisted" counts (split by insert/delete) — a divergence between live-delete-count and persisted-delete-count would have caught this immediately.

**Automation opportunities:** A regression test that (1) applies inserts and deletes to a room, (2) forces a restart/rehydrate, (3) asserts the rehydrated content matches the pre-restart content, added to CI, would prevent recurrence and any similar future bug in this dedup path.

---

### 2. No authentication or authorization on the WebSocket path

**Failure mode:** Any client that can reach the WS port can join any room by `docId` and act as any `replicaId`, with zero credential check anywhere in the request path.

**Trigger:** A `join` message with an arbitrary `docId`/`replicaId` — confirmed via grep across the entire `apps/server` package: no `Authorization` header check, JWT verification, API key, or session mechanism exists anywhere.

**Likelihood:** Certain — this isn't a conditional bug, it's the current, permanent state of the system.

**Blast radius:** Every document in the system, for every user. Any client can read and write to any document, and (per EDGE_CASES §11) can silently evict another client's connection by reusing its `replicaId`.

**Recovery:** N/A — there is no incident to recover from per se, this is a standing exposure until fixed.

**Mitigation:** Add an authentication layer (session token, JWT, or similar) validated on WS connection/join, and an authorization check that a given authenticated identity is permitted to access the requested `docId`. This is a significant, non-trivial architectural addition — see [ARCHITECTURE_REVIEW.md](ARCHITECTURE_REVIEW.md) for the recommended shape.

**Detection:** Trivially detectable by manual testing (connect with any `docId` and observe access is granted) — no monitoring needed to detect the *presence* of the gap, only to detect *exploitation* of it.

**Monitoring:** Once auth exists, add anomaly detection for unusual room-access patterns (one connection touching many distinct `docId`s in a short window is a strong signal of scanning/abuse).

**Automation opportunities:** A CI test asserting that an unauthenticated/unauthorized join attempt is rejected would prevent this from silently regressing once fixed.

---

### 3. Unhandled promise rejections can crash the entire server process on any transient Redis/Postgres error

**Failure mode:** Every hot-path entry point is invoked with `void`, and none of the awaited calls inside those paths are wrapped in try/catch except two specific call sites.

```ts
// apps/server/src/server.ts
socket.on("message", (raw) => { void handleMessage(socket, raw.toString()); });
socket.on("close", () => { if (state) void roomManager.leave(...); });
```
```ts
// apps/server/src/roomManager.ts
sweepTimer: setInterval(() => { void this.tick(docId); }, ...)
await this.pubSubBus.subscribe(docChannel(docId), (raw) => { void this.handleRemoteOp(docId, raw); });
```
A grep of the whole server package confirms no `process.on("unhandledRejection")` or `process.on("uncaughtException")` handler exists anywhere. Node's default behavior (since v15) is to terminate the process on an unhandled rejection.

**Trigger:** Any transient failure in `seqAllocator.next`, `presenceStore.set/remove/sweep`, `pubSubBus.publish`, `persistenceStore.load/writeSnapshot`, or even `JSON.parse` on a malformed remote pub/sub payload — all reachable via unguarded `void`-invoked paths. ioredis's default `maxRetriesPerRequest` (20) means a Redis blip doesn't hang forever, it eventually rejects — and that rejection is unhandled everywhere except the two guarded call sites inside `applyClientOp`/`handleRemoteOp`.

**Likelihood:** High over any meaningfully long production time horizon — transient Redis/Postgres blips (network hiccup, provider maintenance, connection pool exhaustion per [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §7) are a normal, expected occurrence in distributed systems, not a rare event.

**Blast radius:** The entire process — every room and every connection on that instance, not just the one operation that hit the transient error. In a horizontally-scaled deployment this takes down one instance's worth of capacity; in a single-instance deployment it's a full outage.

**Recovery:** Depends entirely on external process supervision (container orchestrator restart policy, PM2, systemd) to bring the process back up. No in-app recovery exists. Any in-flight, un-persisted state at the moment of the crash is lost per finding 4 below.

**Mitigation:** Add a global `process.on("unhandledRejection", ...)` / `process.on("uncaughtException", ...)` handler as a last-resort safety net (log + controlled shutdown rather than an uncontrolled crash), and — more importantly — wrap every I/O-touching async path (sweep tick, pub/sub message handler, presence operations) in try/catch with per-operation error handling rather than letting failures propagate unhandled.

**Detection:** Process-level crash/restart monitoring (any container orchestrator's restart-count metric) would surface this as repeated restarts correlating with Redis/Postgres blip windows.

**Monitoring:** Alert on process restart frequency; alert on Redis/Postgres error rates as a leading indicator before they cascade into a crash.

**Automation opportunities:** A chaos/fault-injection test that simulates a Redis connection drop mid-operation and asserts the server process survives (rather than crashing) would directly validate the fix.

---

### 4. Broadcast-before-persist ordering + Redis pub/sub's non-persistent delivery can turn a transient network blip into permanent data loss

**Failure mode:** `RoomManager.applyClientOp` broadcasts to local clients and publishes to Redis pub/sub *before* durably persisting the op. Redis Pub/Sub has at-most-once, non-persisted delivery (a message published while a subscriber is disconnected is gone forever — this is documented, standard Redis Pub/Sub behavior, not a bug in Redis). `Room.applyOps` has no seq-monotonicity check, so a gap in delivery is silently absorbed rather than detected.

```ts
// roomManager.ts applyClientOp — broadcast happens before durability
room.broadcast({ type: "broadcast-op", docId, seq, ops }, senderReplicaId);      // other clients on THIS instance see it immediately
await this.pubSubBus.publish(docChannel(docId), JSON.stringify(fanoutPayload)); // fan out to other instances
try { await this.persistenceStore.appendOps(docId, seq, ops); ... }             // durability, comes last
```
```ts
// room.ts applyOps — no monotonicity check on seq
applyOps(ops: Op[], seq: number): void {
  this.rga.applyAll(ops);
  this.seq = seq;   // unconditional overwrite, can regress or skip
  this.opLog.push({ seq, ops });
}
```

**Trigger:** A server instance's Redis subscriber connection blips (reconnects) during the exact window another instance publishes an op. ioredis auto-resubscribes on reconnect but never replays messages missed during the gap (standard Redis Pub/Sub semantics). The receiving instance's `handleRemoteOp` then applies the *next* op that does arrive, silently creating a gap in its local `opLog`.

**Likelihood:** Medium — requires a specific but realistic timing coincidence (a subscriber-side Redis blip landing during active writes to a room, followed later by that instance's own snapshot-GC cycle for that room). Not a common event, but a certain eventual occurrence at scale over a long enough time horizon.

**Blast radius:** Worst case — once the affected room's `opsSinceSnapshot` crosses `snapshotOpThreshold`, `snapshotRoom()` snapshots the now-corrupted (gap-containing) in-memory state and calls `writeSnapshot`, which runs `operation.deleteMany({ where: { docId, seq: { lte: atSeq } } })`. This **deletes the correctly-persisted row for the missed op** (written by the originating instance, whose author already received an ack for it) from Postgres. The edit is now permanently gone from the source of truth.

**Recovery:** None automatic once the snapshot-GC has run — the underlying `Operation` row is deleted, and the snapshot that replaces it reflects the gapped state. Recovery would require point-in-time Postgres restore (see finding 10 — no backup strategy exists) or manual data reconstruction from client-side state if any client still has the missing op in its local outbox/cache.

**Mitigation:** Reorder to persist-before-broadcast (durability first, fan-out second) so an op is never visible to any peer before it's durable, and add an explicit seq-monotonicity/gap-detection check in `Room.applyOps` that triggers a resync (re-fetch from persistence) rather than silently accepting a non-contiguous seq.

**Detection:** No existing test exercises this — would require a fault-injection test that drops a pub/sub message mid-stream and asserts the receiving instance detects the gap rather than silently continuing.

**Monitoring:** Track `seq` continuity per room per instance; alert on any observed gap between consecutive applied `seq` values.

**Automation opportunities:** Add the gap-detection check described above as a first step (cheap, high-value); it converts this from a silent-corruption bug into a detected, recoverable resync trigger.

---

### 5. Op-id counter overflow silently causes wrong-node deletion (adversarial-input-triggerable)

**Failure mode:** See full technical detail in [EDGE_CASES.md](EDGE_CASES.md) §4. Summary: a single crafted op with an out-of-bounds `counter` value causes a victim replica's subsequent local op ids to collide, so a later local delete silently removes different content than the user selected.

**Trigger:** One adversarial or buggy peer op reaching `Rga.apply()` via the normal, validated (`parseClientMessage`) WS message path.

**Likelihood:** Low under purely accidental/buggy-client conditions, but trivially reachable by a deliberately malicious client given the complete absence of authentication (finding 2) — any client can send this op to any room.

**Blast radius:** Per-victim-replica, per-document — the corruption is localized to whichever replica received the malicious op, but is silent and has no recovery path once triggered.

**Recovery:** None automatic — the corrupted delete has already removed the wrong content; there is no log distinguishing "intended" from "corrupted" deletes.

**Mitigation:** Add `.max()` bound to `opIdSchema.counter` in the protocol schema (rejects the malicious op at the validation boundary, before it ever reaches `Rga.apply()`).

**Detection:** No existing test sends an out-of-bounds counter value.

**Monitoring:** Once bounded at the schema layer, a rejected/oversized-counter message becomes a validation error, which should be logged and could feed an abuse-detection signal (repeated validation failures from one client is a strong signal of a hostile or badly broken client).

**Automation opportunities:** A fuzz/property test targeting the protocol schema boundary with adversarial numeric inputs (overflow, negative-adjacent, `NaN`-adjacent via string coercion attempts) would catch this class of bug generally, not just this one instance.

---

### 6. `NEXT_PUBLIC_WS_URL` has an unvalidated `localhost` fallback that can ship to production undetected

**Failure mode:**
```ts
// apps/web/src/lib/useDocument.ts:6
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";
```
`NEXT_PUBLIC_*` variables are inlined at build time. `apps/web/wrangler.jsonc` defines no `vars` block, and there's no `.dev.vars` or build-time validation step anywhere in the repo.

**Trigger:** A CI/deploy environment running `opennextjs-cloudflare build` without `NEXT_PUBLIC_WS_URL` set in its environment.

**Likelihood:** Low if deploy tooling is configured correctly and consistently (this is a one-time setup concern, not a recurring risk), but the failure mode has **zero build-time or runtime detection** if it does happen — nothing errors, nothing warns, the bundle just silently bakes in a value that can never work in production.

**Blast radius:** Total, if triggered — every deployed user's browser would attempt to reach `localhost:8080` on their own machine and fail to connect, a full outage of the core collaborative-editing feature (the app would still load, but no document sync would ever succeed). Separately, even a correctly-set non-localhost `ws://` URL would be blocked as mixed content when loaded from an HTTPS page, another silent-failure variant of the same underlying gap (no validation that the configured URL is well-formed and protocol-appropriate for a production HTTPS deployment).

**Recovery:** Redeploy with the correct env var set — fast once diagnosed, but diagnosis relies entirely on someone noticing "sync doesn't work" and tracing it back to a build-time env var, with no error message pointing at the actual cause.

**Mitigation:** Add a build-time assertion (fail the build if `NEXT_PUBLIC_WS_URL` is unset in a production build context) and/or a runtime check that warns loudly (visible in-app banner, not just a console log) if the resolved WS URL is `localhost` while the page itself is not.

**Detection:** None today. A build-time check closes this entirely.

**Monitoring:** Track WS connection failure rate in production; a sudden 100% failure rate immediately post-deploy is the signal, but by then it's already a full outage.

**Automation opportunities:** A CI build step that fails if required `NEXT_PUBLIC_*` vars are unset for a production build target.

---

## HIGH

### 7. No graceful shutdown / SIGTERM handling

**Failure mode:** `RoomManager.close()` exists and correctly clears sweep timers and the rooms map, but is never called from production code — only from tests (confirmed via grep). `apps/server/src/index.ts` (21 lines total) never registers `process.on("SIGTERM", ...)`, never calls `httpServer.close()`, and never drains in-flight connections/writes.

**Trigger:** Any container/orchestrator-issued SIGTERM — a normal, routine event during deploys, rolling restarts, or autoscale-down.

**Likelihood:** Certain — this happens on every deploy, not just in an incident scenario.

**Blast radius:** Every connection and every in-flight operation active on the instance at the moment of shutdown. Node's default action on SIGTERM (with no handler registered) terminates the process immediately: in-flight `persistenceStore.appendOps` awaits are abandoned mid-flight, sockets are hard-cut with no close frame (clients see an abrupt disconnect rather than a clean close), and — per finding 4 — any op already broadcast to peers but not yet durably appended is lost with no recovery path.

**Recovery:** Clients reconnect (per their exponential-backoff logic, see [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §8) and resync via `sinceSeq` — but any op lost mid-flight per the above is gone, not resumed, since it was never durably recorded.

**Mitigation:** Wire `process.on("SIGTERM", ...)` to call the existing (but currently unused-in-production) `RoomManager.close()`, plus `httpServer.close()` with a bounded drain period that waits for in-flight persistence writes before exiting.

**Detection:** Would show up as a small but nonzero rate of "op acked but not present after reconnect" reports correlated with deploy timestamps, if anyone were tracking that correlation.

**Monitoring:** Track deploy events against op-loss/resync-gap metrics (once finding 4's gap-detection exists) to confirm graceful shutdown eliminates deploy-correlated loss.

**Automation opportunities:** An integration test that sends SIGTERM to a running server instance mid-write and asserts no data loss would directly validate the fix.

---

### 8. `/healthz` doesn't check any dependency — always returns 200

**Failure mode:**
```ts
// apps/server/src/server.ts:34-36
app.get("/healthz", (_req, res) => { res.status(200).json({ ok: true }); });
```
Returns success unconditionally, regardless of Redis or Postgres reachability.

**Trigger:** Any Redis or Postgres outage/unreachability while the Node process itself is still running.

**Likelihood:** Medium — dependency outages are less frequent than transient blips but are a normal occurrence over a long enough time horizon (provider maintenance windows, network partitions, connection pool exhaustion per [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §7).

**Blast radius:** A readiness/liveness probe backed by this endpoint keeps routing traffic to an instance that cannot persist, fan out, or track presence. Clients connect successfully (the WS handshake itself doesn't touch Redis/Postgres), and every subsequent write then fails — best case the sender gets a `PERSIST_FAILED`-style error, worst case (per finding 3) the process crashes on the next unguarded transient error, but either way the orchestrator has no signal to stop routing new connections to this broken instance.

**Recovery:** Manual intervention required to notice the instance is unhealthy and remove it from rotation, absent a real health check.

**Mitigation:** Make `/healthz` (or add a separate `/readyz`) actually ping Redis and Postgres with a short timeout, returning a non-200 status if either is unreachable, so the orchestrator can stop routing traffic to the instance and/or restart it.

**Detection:** Trivially testable manually (kill Redis, observe `/healthz` still returns 200).

**Monitoring:** Once fixed, the orchestrator's own health-check-failure metrics become the monitoring signal.

**Automation opportunities:** A test asserting `/healthz` returns non-200 when a mocked dependency is unreachable.

---

### 9. No error handling around IndexedDB — silent write loss and infinite "Loading…" on failure

**Failure mode:** No `try/catch` exists anywhere around `openDB`/`db.put`/`db.get`/`db.delete` in `apps/web/src/lib/db.ts`. `DocumentClient`'s constructor invokes `init()` (which awaits IndexedDB operations) with a bare `void this.init();` — no `.catch`.

**Trigger:** IndexedDB unavailable or restricted (Safari private browsing throws/rejects on `indexedDB.open`) or quota exceeded on a `put`.

**Likelihood:** Medium — Safari private browsing and storage-quota exhaustion are both realistic, non-exotic real-world conditions for a subset of users.

**Blast radius:** Per-affected-user. If `init()` rejects, it never completes, `connect()` is never called, and the UI is stuck showing "Loading…" indefinitely with no explanation and no degraded fallback (e.g., in-memory-only editing). Separately, every persistence call in `documentClient.ts` (`addToOutbox`, `removeFromOutbox`, `persistDocumentState`) is fire-and-forget with no `.catch` — if a write fails, the failure is swallowed, so the in-memory state silently diverges from what's actually durable on disk, and a later reload silently drops those "persisted" edits.

**Recovery:** None from the user's perspective — no error message, no retry option, just a permanently stuck loading state or, worse, silently-lost edits discovered only on next reload.

**Mitigation:** Wrap `init()`'s call site in `.catch()` with a user-visible error state (not just infinite "Loading…"), and add `.catch()` handlers to every fire-and-forget persistence call with at minimum a logged warning and ideally a visible "changes may not be saved" indicator.

**Detection:** No test simulates an IndexedDB failure (quota exceeded, `openDB` rejection) — would require mocking IndexedDB failure modes.

**Monitoring:** Client-side error tracking (e.g., Sentry-style) capturing unhandled promise rejections in the browser would surface this in production even without dedicated tests.

**Automation opportunities:** A test suite using a fake-indexeddb implementation configured to reject/throw would let this be regression-tested.

---

### 10. No backup or disaster-recovery strategy for Postgres

**Failure mode:** No backup, point-in-time-recovery, or restore-testing strategy exists anywhere in the repo or its infra config. Self-confirmed by the project's own (untracked, gitignored) `DEPLOYMENT.md`: *"Backups: none configured by this repo — enable your Postgres provider's own automated backups... free tiers typically don't"* and *"No automated backups on any of the free tiers used here."*

**Trigger:** Any data-loss event — accidental deletion, the corruption bugs described in findings 1, 4, and 5 above, a botched migration, or a provider-side incident.

**Likelihood:** Low per individual incident, but the *consequence* of any of the several corruption bugs already identified in this audit (findings 1, 4, 5) is currently unrecoverable precisely because this safety net doesn't exist.

**Blast radius:** Total and permanent, for whatever data loss occurs — with no backup, there is no recovery path at all, only whatever a specific managed-provider tier might offer by default (explicitly noted by the project's own docs as typically absent on free tiers).

**Recovery:** None, as currently configured.

**Mitigation:** Enable the Postgres provider's automated backup/PITR feature (upgrading tier if necessary), and perform at least one documented restore-drill to confirm the backup is actually usable (an untested backup is not a reliable backup).

**Detection:** N/A (this is an absence, not a detectable event).

**Monitoring:** Once backups exist, monitor backup-job success/failure and alert on missed backup windows.

**Automation opportunities:** Schedule periodic automated restore-drills (restore to a scratch instance, run a data-integrity check) rather than relying on backups existing but never being verified.

---

### 11. No CI/CD pipeline — no automated test gate before merge or deploy

**Failure mode:** No `.github/`, `Jenkinsfile`, `.gitlab-ci.yml`, `.circleci/`, or `azure-pipelines.yml` exists anywhere in the repo (confirmed via glob across the whole tree, excluding `node_modules`). Self-acknowledged in the project's own untracked `DEPLOYMENT.md`: *"No `.github/` exists in the repo today. Suggested workflows below..."* — i.e., GitHub Actions YAML is drafted in a doc but never actually committed or wired up. Deploys are entirely manual (per the untracked `DEPLOY_CHECKLIST.md`: a human runs `npm run db:deploy` and clicks through provider dashboards).

**Trigger:** Every single merge to `main` and every deploy.

**Likelihood:** Certain — this is the standing state of the project, not a conditional risk.

**Blast radius:** Any regression, type error, or failing test can be merged and deployed without any automated check catching it first — the entire test suite that exists (and per this audit, it's reasonably thorough for `packages/crdt` and `apps/server`) provides no protection unless someone remembers to run it manually before every merge.

**Recovery:** N/A — this is a process gap, not an incident.

**Mitigation:** Stand up the CI workflow already drafted (per the project's own untracked docs) as an actual `.github/workflows/*.yml` file: run `npm test`, `npm run build`, and type-checking on every PR, and gate merges on it passing.

**Detection:** N/A.

**Monitoring:** Track post-merge incident rate before/after CI is introduced as an informal measure of impact.

**Automation opportunities:** This finding *is* the automation opportunity — implementing it directly closes the gap.

---

### 12. Unbounded protocol payloads and pending-op buffer are a cheap, effective memory-exhaustion DoS vector

**Failure mode:** See [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §2-3 for full technical detail. Summary: no size bounds exist anywhere in the wire protocol schema, and `Rga.apply()`'s `pending` buffer for causally-stalled ops has no cap, TTL, or eviction — empirically confirmed to accept 1000+ permanently-buffered fabricated ops from a single test loop with zero pushback.

**Trigger:** A single WS client sending ops with fabricated, never-arriving `originId`/`targetId` references, or simply very large `ops` arrays / `value` strings.

**Likelihood:** High — trivially cheap for any client to send (no special tooling or exploit needed, just malformed-but-schema-valid messages), and there is no authentication (finding 2) restricting who can connect and send them.

**Blast radius:** Per-room memory growth, unbounded — could be directed at a single room to exhaust that room's/instance's available memory, potentially triggering the crash path in finding 3 once memory pressure causes downstream allocation failures or GC pauses severe enough to affect other operations.

**Recovery:** Process restart clears the buffer (at the cost of the graceful-shutdown gap in finding 7); no in-app recovery exists otherwise.

**Mitigation:** Add `.max()` bounds to the protocol schema (message/array/string size caps) and a cap+TTL on the `pending` buffer, as detailed in [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §2-3.

**Detection:** Memory-usage monitoring per room/instance would surface an active attack, but nothing today distinguishes this from organic load.

**Monitoring:** Track `pending` buffer size per room as a metric; alert on any room's buffer exceeding a small, expected-to-be-near-zero threshold.

**Automation opportunities:** A load/fuzz test that specifically sends fabricated-dependency ops and asserts bounded memory growth would validate the fix.

---

## MEDIUM

### 13. No connection or room caps — unauthenticated resource exhaustion

**Failure mode:** `RoomManager`'s `rooms` map has no size cap. Since joining requires no credential (finding 2), any client can create unbounded distinct `docId`s, each producing a full in-memory `Room` (with its own RGA, dedicated `setInterval` sweep timer, and two Redis pub/sub subscriptions). No rate limiting exists anywhere in the codebase (confirmed via grep for `rateLimit`/`maxConnections` — zero hits).

**Trigger:** A client (or script) repeatedly joining new, never-before-seen `docId`s.

**Likelihood:** Medium — requires deliberate action (accidental triggering via normal use is unlikely), but trivially easy to do deliberately given no auth or rate limiting.

**Blast radius:** Server-wide — timer count, Redis subscription count, and memory footprint all grow linearly with attacker-controlled room count, with no ceiling.

**Recovery:** Process restart, or manual intervention to identify and block the offending client (no built-in mechanism to do so).

**Mitigation:** Add a global cap on concurrent active rooms per instance, and per-client rate limiting on join/room-creation requests.

**Detection:** Room count and timer count as server metrics would surface an ongoing attack.

**Monitoring:** Alert on room-count growth rate exceeding expected organic bounds.

**Automation opportunities:** A test asserting room creation is rejected past a configured cap.

---

### 14. Seq allocator: Redis outage propagates into the process-crash path

**Failure mode:** `RedisSeqAllocator.next()`'s `INCR` call is correctly atomic across instances for the happy path, but has no timeout or circuit breaker of its own beyond ioredis's default retry/backoff (up to 20 attempts before rejecting).

**Trigger:** A Redis outage or extended unavailability during active write traffic.

**Likelihood:** Low-medium — Redis outages are less frequent than transient blips but are a normal occurrence over time.

**Blast radius:** Every `applyClientOp` call blocks through the full retry/backoff period before eventually rejecting into finding 3's unguarded crash path — so a Redis outage doesn't just degrade write latency, it can crash the process entirely.

**Recovery:** Depends on finding 3's mitigation (unhandled rejection handling) and finding 7's mitigation (graceful shutdown) both being in place; currently, recovery is "wait for process supervisor to restart, hope Redis is back by then."

**Mitigation:** Add an explicit timeout/circuit-breaker around seq allocation shorter than ioredis's full retry exhaustion, with a clear, handled error path (reject the client op with a retryable error) rather than letting the failure cascade into an unhandled rejection.

**Detection:** Correlate seq-allocation latency/error-rate spikes with Redis availability metrics.

**Monitoring:** Alert on seq-allocation error rate and p99 latency.

**Automation opportunities:** A fault-injection test simulating Redis unavailability during `next()` and asserting a clean, handled rejection rather than a crash.

---

### 15. No environment variable validation — missing config silently falls back to insecure/incorrect defaults

**Failure mode:**
```ts
// apps/server/src/index.ts
const port = Number(process.env.PORT ?? 8080);
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ysync";
```
No schema (zod or otherwise) validates required env vars at startup; every read falls back silently to a hardcoded localhost/default-credential value.

**Trigger:** A deploy misconfiguration that fails to set `DATABASE_URL`/`REDIS_URL`.

**Likelihood:** Low if deploy tooling is set up correctly and consistently, but — like finding 6 — has zero detection if it does happen.

**Blast radius:** The server silently attempts to connect to `localhost` with default `postgres`/`postgres` credentials instead of the real production database, producing a cryptic connection-refused error deep inside Prisma rather than a clear "DATABASE_URL is required" failure at boot.

**Recovery:** Fast once diagnosed (set the correct env var and redeploy), but diagnosis time is elongated by the unhelpful error message.

**Mitigation:** Validate all required env vars at startup with a schema (e.g., zod) that fails fast with a clear error message (`"DATABASE_URL is required and was not set"`) instead of silently substituting a dev default.

**Detection:** None today.

**Monitoring:** Startup-failure alerting would catch this immediately once the fail-fast validation is in place.

**Automation opportunities:** A startup smoke test in CI/deploy that verifies the server refuses to start without required env vars set.

---

## LOW / SELF-ACKNOWLEDGED

### 16. Acknowledged durability gap between broadcast and persist (author-documented, narrower than finding 4)

**Failure mode:** The project's own tracked docs (`docs/README.md:110-114`, `docs/changes/phase-4-persistence.md:78-79`) explicitly state: *"Known gap, not solved here: if the originating process crashes between broadcasting and persisting, and no other process happened to also receive+persist that op, it's visible to whoever was live but not durable."*

**Trigger:** Originating process crash in the narrow window between broadcast and persist, with no other instance having independently received+persisted the same op.

**Likelihood:** Low (narrow timing window) but real, and explicitly acknowledged by the project authors as a known, deliberately-deferred gap rather than an oversight.

**Blast radius:** Limited to whichever ops were in-flight at the exact moment of crash.

**Recovery:** None automatic, same as findings 3/4/7 which compound this.

**Mitigation:** Same underlying fix as finding 4 (persist-before-broadcast ordering) — this acknowledged gap and finding 4 share a root cause.

**Detection:** N/A — already known and documented by the project.

**Monitoring:** N/A — see finding 4's monitoring recommendation.

**Automation opportunities:** See finding 4.
