# ARCHITECTURE_REVIEW.md — YSync Production Audit

Staff-Engineer-level architecture review of YSync: a collaborative rich-text editor built on a custom RGA CRDT (`packages/crdt`), a JSON wire protocol (`packages/protocol`), a centralized WebSocket server with pluggable in-memory/Redis/Postgres backends (`apps/server`), and a Next.js frontend deployed to Cloudflare via OpenNext (`apps/web`). This is a real, working, well-tested prototype of a sound architectural approach (centralized sequencing + CRDT for offline-tolerant convergence is a reasonable, proven pattern) — the findings below are gaps between "sound design" and "production-ready," not indictments of the overall approach.

Related documents: [EDGE_CASES.md](EDGE_CASES.md), [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md), [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md).

---

## 1. No authentication/authorization layer exists anywhere in the system

**Current architecture:** The WS server accepts any `join` message with a client-supplied `docId`/`replicaId` and grants full read/write access, with no identity or permission model anywhere in `apps/server`, `packages/protocol`, or `packages/database`.

**Problem:** There is no concept of a "user" distinct from an ephemeral, self-asserted `replicaId` in the entire system. Document ownership, sharing, and access control — features any real collaborative-editing product needs — have no architectural foundation to build on yet.

**Evidence:** Confirmed via grep across the whole repo: no `Authorization`/JWT/session/API-key handling anywhere; `Document` in `packages/database/prisma/schema.prisma` has no owner/ACL fields.

**Production consequences:** Full technical detail in [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §2 — any client can read/write any document.

**Recommended architecture:** Introduce an identity layer (session-based or JWT, validated at WS-connection or `join`-message time) and a `DocumentAccess`/ACL table (or simpler owner-only model for v1) that `RoomManager.join`/`applyClientOp` checks before granting room access or accepting writes. This is a foundational addition that touches the protocol (join messages need to carry a credential), the server (auth middleware ahead of WS upgrade or as the first step of `join` handling), and the database (new tables/columns for ownership).

**Migration path:** (1) Add auth token issuance (even a minimal signed-session-cookie approach) to `apps/web`. (2) Extend the `join` protocol message to carry the token. (3) Add server-side validation + a `DocumentAccess` table, defaulting existing documents to "open" during a transition window if backward compatibility with already-shared documents matters. (4) Flip the default to "closed" once clients are updated.

**Tradeoffs:** This is the single largest scope item in this entire audit — it's not a bug fix, it's a missing subsystem. Every other finding in this report is secondary in priority to this one for any deployment with real, non-trusted users.

**Risk level:** Critical (of the entire system's readiness for any multi-tenant/public use).

**References:** `apps/server/src/roomManager.ts:113-127, 136-157`; `packages/database/prisma/schema.prisma:1-15`.

---

## 2. No CI/CD pipeline — quality gates exist only in the test suite, not in the merge/deploy process

**Current architecture:** A reasonably thorough test suite exists (`packages/crdt`, `packages/protocol`, and especially `apps/server` — which has genuine integration tests against real Redis/Postgres, multi-instance coordination tests, and a restart/rehydration test), but nothing runs it automatically. Deploys are entirely manual, per the project's own untracked `DEPLOY_CHECKLIST.md`.

**Problem:** The gap isn't test coverage (which is genuinely above-average for a project this size) — it's that the coverage provides zero protection unless a human remembers to run it before every merge and deploy, every time, with no exceptions.

**Evidence:** No `.github/`, `.gitlab-ci.yml`, or equivalent exists anywhere in the repo (confirmed via glob). Self-acknowledged in the project's own untracked `DEPLOYMENT.md`, which drafts GitHub Actions YAML that was never actually committed.

**Production consequences:** Full detail in [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §11 — any regression can reach `main` and production undetected by anything but manual diligence.

**Recommended architecture:** A standard GitHub Actions workflow: `npm test`, `npm run build`, and type-checking on every PR, branch-protection rules requiring it to pass before merge, and a separate deploy workflow triggered on merge to `main` (or manually gated, if deploy approval is desired) that runs `npm run db:deploy` and the Cloudflare/Render deploy steps currently done by hand per `DEPLOY_CHECKLIST.md`.

**Migration path:** Low-risk, mechanical — the workflows are reportedly already drafted in the untracked `DEPLOYMENT.md`; the work is committing and wiring them up, not designing them from scratch.

**Tradeoffs:** None significant — this is close to a pure win with minimal downside, standard practice, and low implementation cost relative to its risk reduction.

**Risk level:** High priority, low implementation risk.

**References:** `docs/` (no `.github/` present); untracked `DEPLOYMENT.md`, `DEPLOY_CHECKLIST.md`.

---

## 3. Rich-text formatting has no real CRDT conflict-resolution design

**Current architecture:** Character-level insert/delete is a properly-designed RGA CRDT with sound tie-breaking and convergence guarantees. Formatting (`FormatMark`/`attrs`) is bolted on as single-slot, position-order-dependent open/close toggle markers with no identity-based pairing — see full technical detail in [EDGE_CASES.md](EDGE_CASES.md) §3.

**Problem:** The character CRDT and the formatting model are architecturally inconsistent in their conflict-resolution sophistication — one is a real CRDT, the other is a linear-scan toggle with no conflict resolution at all. This isn't a bug in an otherwise-sound design, it's a design that hasn't been extended to cover its second major feature area (rich text formatting) with the same rigor as its first (plain text).

**Evidence:** `packages/crdt/src/rga.ts:117-145` (see EDGE_CASES §3 for the reproduced corruption).

**Production consequences:** Concurrent formatting operations — a completely normal collaborative-editing action — corrupt document formatting silently, as demonstrated.

**Recommended architecture:** Adopt a known, proven approach for CRDT rich-text formatting — e.g., Peritext's approach (marks identified by their own stable id, paired by id rather than list-traversal order, resilient to the marked span being partially deleted or the mark itself needing independent conflict resolution when two marks of the same type overlap). This is a research-informed design problem, not a quick patch — worth a dedicated design pass referencing the Peritext paper/prior art before implementation, given the task's own instruction to prefer authoritative sources over invented behavior.

**Migration path:** This changes the wire format for `FormatMark`/attrs-bearing ops, so it needs protocol versioning consideration (see item 12) and likely a full rewrite of the formatting subsystem rather than an incremental patch — existing documents with formatting would need either a migration script or graceful handling of the old format alongside the new.

**Tradeoffs:** Significant implementation effort for a feature (formatting) that's currently only partially working; the alternative (ship without concurrent-formatting support, i.e., last-write-wins for formatting, explicitly documented as a known limitation) is a legitimate, much cheaper interim design choice if full CRDT-formatting isn't worth the investment yet.

**Risk level:** High (correctness), but implementation-effort-gated — worth an explicit product decision on how much investment concurrent formatting correctness deserves before committing to the full redesign.

**References:** `packages/crdt/src/rga.ts:117-145`; `packages/crdt/src/node.ts` (FormatMark type).

---

## 4. No foreign-key constraints between `Operation`/`Snapshot` and `Document`

**Current architecture:** `Operation.docId` and `Snapshot.docId` are plain `TEXT` columns with no `@relation` in the Prisma schema and no `FOREIGN KEY` clause in the generated migration SQL — referential integrity is entirely application-enforced.

**Problem:** Postgres will accept `Operation`/`Snapshot` rows for a `docId` that has no corresponding `Document` row, and will keep orphaned rows forever if a `Document` is ever deleted through any path that doesn't also explicitly clean up its children. This is a data-model gap that trades away a database-level correctness guarantee for (presumably) either flexibility or an oversight — nothing in the docs indicates it was a deliberate tradeoff.

**Evidence:** `packages/database/prisma/schema.prisma:12-44`; confirmed no `FOREIGN KEY` in `migration.sql`.

**Production consequences:** Silent orphaned-row accumulation on any document-deletion path (if one is ever added — none currently exists per this audit); no database-level protection against a bug that writes an `Operation` row for a typo'd/nonexistent `docId`.

**Recommended architecture:** Add `@relation` fields with `onDelete: Cascade` (or `Restrict`, depending on whether document deletion should be soft or should require explicit child cleanup first) from `Operation`/`Snapshot` to `Document`.

**Migration path:** Straightforward Prisma schema change + migration; should audit for any already-orphaned rows before adding the constraint (a constraint addition will fail if violating rows already exist).

**Tradeoffs:** None significant — this is standard relational-integrity practice with no notable downside for this schema shape.

**Risk level:** Medium.

**References:** `packages/database/prisma/schema.prisma:12-44`.

---

## 5. No production Dockerfile, Kubernetes/Helm, or Terraform/Pulumi — deployment is manual and provider-dashboard-driven

**Current architecture:** `docker-compose.yml` at the repo root is explicitly dev-only (Postgres + Redis containers for local `docker compose up -d`; both apps still run natively via `npm run dev`, confirmed by `docs/changes/phase-8-cleanup.md`). Actual deploy targets, per the untracked `DEPLOY_CHECKLIST.md`, are Render (server, via `npm start`, not a container built from this repo) and Cloudflare Workers via OpenNext (web) — neither path uses a Dockerfile from this repo, and no infrastructure-as-code (Terraform/Pulumi/Helm) exists anywhere.

**Problem:** Infrastructure configuration lives entirely in provider dashboards (Render's UI, Cloudflare's UI) rather than in version control — not necessarily wrong for this stack and current scale, but it means there's no reviewable diff for infra changes, no reproducible environment definition, and no way to stand up a fresh environment (staging, disaster-recovery target) without manually re-clicking through both dashboards from memory.

**Evidence:** Confirmed via glob across the whole repo (excluding `node_modules`) for `Dockerfile*`, `**/*.tf`, `helm/**`, `**/*.yaml` (k8s-style) — none found outside the dev-only `docker-compose.yml`.

**Production consequences:** Slower, error-prone environment reproduction; no infra-change review process; bus-factor risk (see item 6) compounds this — the people who know the current dashboard configuration are the only source of truth.

**Recommended architecture:** At minimum, capture the current Render/Cloudflare configuration as code (Terraform providers exist for both, or at minimum a checked-in, detailed runbook if full IaC is out of scope for current team size/scale). A production Dockerfile for `apps/server` would also decouple deployment from Render's specific build process and enable easier migration to other container platforms later.

**Migration path:** Incremental — start with documenting/version-controlling the current dashboard config as a runbook (cheap), then evaluate IaC adoption as the team/infra grows in complexity.

**Tradeoffs:** IaC adds tooling overhead that may be disproportionate for a small team's current scale — this is a judgment call on timing, not an unconditional "must fix now."

**Risk level:** Medium.

**References:** `docker-compose.yml`; `docs/changes/phase-8-cleanup.md`; untracked `DEPLOY_CHECKLIST.md`.

---

## 6. Production operational knowledge lives entirely outside version control

**Current architecture:** `.gitignore` explicitly excludes `system-design.md`, `plan.md`, `DESIGN.md`, `DEPLOY_CHECKLIST.md`, and `DEPLOYMENT.md`. These are the only documents describing the actual production stack (Render + Cloudflare/OpenNext + Neon + Upstash per their content), the deploy process, and — notably — the project's own self-audit of known gaps (no rate limiting, no backups, no monitoring beyond `/healthz`, draft-only CI workflows).

**Problem:** This creates a bus-factor/knowledge-silo risk stacked on top of the CI/CD and backup gaps already identified: nothing that ships to another engineer, a CI runner, or a fresh clone of the repo contains this operational knowledge. If the primary maintainer's machine is unavailable, this knowledge is gone, not just inconvenient to access.

**Evidence:** `.gitignore:6-7, 15-17`.

**Production consequences:** Onboarding a second engineer, recovering from an incident without the primary maintainer available, or auditing the system (as this very report attempts) all depend on access to files that aren't part of the repository's actual deliverable.

**Recommended architecture:** Move non-sensitive operational docs (design docs, deploy checklists, known-gaps lists) into version control under `docs/`; keep only genuinely sensitive material (credentials, if any were ever in these files — none were found) out of git.

**Migration path:** Trivial — `git add` the files and adjust `.gitignore`, after confirming none contain secrets that need separate handling first.

**Tradeoffs:** None significant.

**Risk level:** Medium.

**References:** `.gitignore:6-7, 15-17`.

---

## 7. `packages/database` has zero automated tests, silently masked by `--if-present`

**Current architecture:** Root `package.json`'s `"test": "npm run test --workspaces --if-present"` silently skips any workspace without a `test` script — `packages/database/package.json` has none, and no `*.test.ts` file exists anywhere under `packages/database`.

**Problem:** The `--if-present` flag is a reasonable pattern in general (not every workspace needs tests), but here it masks a real gap: there is no automated verification of schema correctness, migration application, or the `createPrismaClient`/driver-adapter wiring — only manual, ad hoc verification described in `docs/changes/phase-4-persistence.md`. The same masking pattern applies to the `"build"` script too, currently harmless (every workspace defines one) but a latent trap if a future workspace omits it.

**Evidence:** `packages/database/package.json:14-19`; root `package.json:10`.

**Production consequences:** A schema or migration regression in `packages/database` would not be caught by `npm test` at the repo root, relying entirely on the (also entirely manual, per item 2) deploy process to surface it.

**Recommended architecture:** Add at minimum a migration-application smoke test (spin up a throwaway Postgres via `docker-compose.yml`, run `db:deploy`, assert it succeeds and the resulting schema matches expectations) to `packages/database`.

**Migration path:** Additive — no existing behavior changes, just new test coverage.

**Tradeoffs:** None significant.

**Risk level:** Medium.

**References:** `packages/database/package.json:14-19`; root `package.json:10`.

---

## 8. No React error boundary — a single component exception can take down the whole page

**Current architecture:** No `error.tsx`/`global-error.tsx` exists anywhere under `apps/web/src/app/`, and no `ErrorBoundary`/`componentDidCatch` pattern exists anywhere in `apps/web/src` (confirmed via grep).

**Problem:** Next.js App Router relies on `error.tsx` (segment-level) or `global-error.tsx` (root) for graceful recovery from render-time exceptions. Without either, any runtime exception in `Editor`/`DocEditor` — including the reachable `localDelete` throw described in [EDGE_CASES.md](EDGE_CASES.md) §6/§7 — sends the entire page to Next's bare, unstyled default error screen, with no recovery path short of a full reload.

**Evidence:** Confirmed via file listing and grep across `apps/web/src/app/`.

**Production consequences:** A recoverable, localized bug (one bad edit interaction) becomes an unrecoverable, whole-page failure from the user's perspective.

**Recommended architecture:** Add `error.tsx` at the `app/doc/[slug]/` segment level (scoped recovery — a broken editor shouldn't take down site-wide chrome) with a "reload document" action, plus a root `global-error.tsx` as a last-resort catch-all.

**Migration path:** Purely additive — new files, no existing behavior changes.

**Tradeoffs:** None significant.

**Risk level:** Medium.

**References:** `apps/web/src/app/` (absence); `apps/web/src/components/Editor.tsx`.

---

## 9. No security headers or CSP configured

**Current architecture:**
```ts
// apps/web/next.config.ts
const nextConfig: NextConfig = { /* config options here */ };
```
Completely empty — no `headers()` function, no CSP, no `X-Frame-Options`/`Referrer-Policy`/`Permissions-Policy`. `wrangler.jsonc` adds nothing either, leaving only whatever Cloudflare's platform defaults provide (which do not include a CSP).

**Problem:** No defense-in-depth layer exists against content-injection-class issues, framing/clickjacking, or referrer leakage, relying entirely on React's default auto-escaping (which is real protection for the XSS vectors checked in this audit — no `dangerouslySetInnerHTML` usage was found — but is not a substitute for response-header-level defense-in-depth, especially given the app embeds a third-party rich-text editor library).

**Evidence:** `apps/web/next.config.ts:1-7`; `apps/web/wrangler.jsonc`.

**Production consequences:** No direct exploit was found in this audit, but the absence itself is a standard security-review finding — defense-in-depth headers are cheap to add and materially reduce blast radius if an injection vector is ever introduced later (e.g., by a future feature that does need to render user-provided HTML).

**Recommended architecture:** Add a `headers()` function in `next.config.ts` (or Cloudflare-side headers via `wrangler.jsonc`/`_headers`) setting a reasonable CSP, `X-Frame-Options: DENY` (or `SAMEORIGIN`), `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy` restricting unused browser features.

**Migration path:** Additive, low-risk — test carefully against the WS connection (CSP `connect-src` must explicitly allow the `wss://` origin) and any third-party resources Quill or other dependencies load.

**Tradeoffs:** CSP misconfiguration can break legitimate functionality (e.g., blocking the WS connection itself) if not tested carefully — recommend a report-only CSP rollout first.

**Risk level:** Medium.

**References:** `apps/web/next.config.ts:1-7`; `apps/web/wrangler.jsonc`.

---

## 10. Tombstone-retention data model has no compaction/garbage-collection protocol

**Current architecture:** The RGA's tombstone handling (full technical/performance detail in [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §1) clears a deleted node's payload but never removes it from the list or id map — an architectural decision (or omission) with no accompanying causal-stability tracking or GC protocol design.

**Problem:** This isn't just a performance issue (covered separately) — it's the absence of a designed protocol for a problem every long-lived CRDT system eventually must solve: safely reclaiming tombstone storage without violating convergence guarantees for replicas that haven't yet seen a given tombstone. No design exists in this codebase for how that would work (e.g., version vectors, causal stability tracking, or a simpler time/ack-based retention window).

**Evidence:** `packages/crdt/src/rga.ts:190-199` (full compactTombstones implementation, confirmed to be payload-only).

**Production consequences:** See [PERFORMANCE_BOTTLENECKS.md](PERFORMANCE_BOTTLENECKS.md) §1 for the growth-curve detail.

**Recommended architecture:** Design a causal-stability-based (or simpler retention-window-based, if full causal tracking is deemed excessive for v1) tombstone GC protocol before this becomes a production problem on real long-lived documents — this is exactly the kind of "verify against authoritative CRDT literature/prior art" item the audit's own instructions call for; standard references include the original RGA paper and production CRDT systems' documented GC approaches (Automerge, Yjs).

**Migration path:** Additive to the existing `Rga` class — a new GC method that actually splices nodes, gated behind whatever safety condition is chosen (causal stability check or time-window heuristic).

**Tradeoffs:** True causal-stability tracking requires additional metadata (version vectors or equivalent) and protocol changes; a simpler time-based heuristic is cheaper but weaker (risk of GC'ing a tombstone a slow/offline replica still needs to reconcile against).

**Risk level:** Medium (performance-correctness boundary — currently a performance concern, would become a correctness concern if GC is added carelessly without the causal-safety analysis).

**References:** `packages/crdt/src/rga.ts:190-199`.

---

## 11. `Room.applyOps` has no seq-monotonicity invariant enforcement

**Current architecture:** `this.seq = seq` in `Room.applyOps` is an unconditional overwrite with no assertion that `seq` is contiguous with or greater than the room's current value.

**Problem:** This is the specific architectural gap that allows [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §4's pub/sub-gap scenario to silently corrupt state instead of being detected and recovered from. A defensive invariant check here is cheap, general-purpose protection against an entire class of ordering/delivery bugs (not just the one already identified) — the kind of "trust the network is well-behaved" assumption that recursive analysis (per this audit's mandate) flags as needing an explicit failure path.

**Evidence:** `apps/server/src/room.ts:84-89`.

**Production consequences:** See [PRODUCTION_FAILURES.md](PRODUCTION_FAILURES.md) §4.

**Recommended architecture:** Add an explicit check: if the incoming `seq` isn't the expected next value, log a warning/metric and trigger a resync (re-fetch authoritative state from `PersistenceStore`) rather than silently accepting the gap.

**Migration path:** Small, localized change to `Room.applyOps` plus a resync code path in `RoomManager` (which likely already has the pieces needed, since `Room.hydrate` already exists for cold-start rehydration — this would reuse similar logic for a mid-session resync).

**Tradeoffs:** A resync is more disruptive to affected clients than silent (but wrong) continuation — but correctness should win here given the alternative is undetected data loss (finding 4).

**Risk level:** High priority given it's the direct architectural fix for a Critical production-failure finding, low implementation risk.

**References:** `apps/server/src/room.ts:84-89`.

---

## 12. No protocol/schema versioning strategy

**Current architecture:** `packages/protocol`'s message schemas have no version field or negotiation mechanism — client and server are assumed to always run matching protocol versions (reasonable for a monorepo with lockstep deploys today, but not a foundation that survives independent client/server versioning, e.g., a cached/offline PWA client running old code against a newly-deployed server).

**Problem:** As soon as `apps/web` and `apps/server` can be deployed independently (a near-certainty as the system matures — different release cadences, canary deploys, or long-lived offline clients per the app's own offline-first IndexedDB design), a protocol change with no version negotiation risks silent incompatibility: an old client sending a message shape the new server's Zod schema rejects (a hard failure, at least visible) or — worse — a shape that happens to still parse but means something subtly different (a silent-corruption risk, in the same family as several findings above).

**Evidence:** `packages/protocol/src/messages.ts` (no version field in any message schema).

**Production consequences:** Currently none (lockstep deploys) — this is a forward-looking architectural gap, relevant directly to item 3's recommendation (any formatting-protocol redesign needs versioning to be safe) and to the offline-client design already present in `apps/web`.

**Recommended architecture:** Add a `protocolVersion` field to the initial handshake/`join` message, with the server able to reject (with a clear error) or adapt to a mismatched version, rather than assuming compatibility.

**Migration path:** Additive — add the field now (even with a single supported value) so the negotiation point exists before it's urgently needed.

**Tradeoffs:** Minor added complexity now for meaningfully reduced risk later, standard practice for any system expected to evolve its wire format.

**Risk level:** Low today, escalating with any independent-deploy or long-lived-offline-client scenario — worth addressing proactively given item 3 already motivates a protocol change.

**References:** `packages/protocol/src/messages.ts`.

---

## 13. Build artifacts partially committed to version control

**Current architecture:** `git ls-files` shows two files under `apps/web/.open-next/.build/` committed to the repo (`open-next.config.edge.mjs`, `open-next.config.mjs`), while the rest of `.open-next/` is excluded only incidentally — `git check-ignore -v` confirms the exclusion comes from generic `/.next/`/`/node_modules` rules in `apps/web/.gitignore`, not any Cloudflare/OpenNext-specific ignore rule (none exists).

**Problem:** Inconsistent handling of generated build output — most of it is accidentally excluded by unrelated ignore rules, but two files slipped through and are tracked. This is repo-hygiene rather than a functional defect (the local `.open-next/` directory is otherwise empty of top-level files, consistent with an interrupted/partial local build rather than a shipped defect), but it's the kind of drift that compounds over time without an explicit ignore rule.

**Evidence:** `git ls-files apps/web/.open-next`; `git check-ignore -v` against the tracked files.

**Production consequences:** Low — stale committed build artifacts can cause confusion (which version is authoritative: the committed file or the one regenerated by `deploy:cf`?) but don't currently appear to affect the actual deploy process, which regenerates `.open-next/` fresh.

**Recommended architecture:** Add an explicit `/.open-next/` (and `/.wrangler/`) ignore rule to `apps/web/.gitignore`, and remove the two currently-tracked files from version control.

**Migration path:** Trivial — `git rm --cached` the two files, add the ignore rule.

**Tradeoffs:** None.

**Risk level:** Low.

**References:** `apps/web/.gitignore`; `apps/web/.open-next/.build/`.

---

## Summary judgment

The core CRDT/protocol/server architecture is a legitimate, well-tested implementation of a sound pattern (centralized sequencing + RGA CRDT for convergence, pluggable in-memory/Redis/Postgres backends for horizontal scaling) — the test suite in `apps/server` in particular reflects real engineering discipline (multi-instance coordination tests, restart/rehydration tests, real-Redis/Postgres integration tests, not just mocks). The gaps found are overwhelmingly in the categories a prototype-to-production transition typically hasn't reached yet: authentication, operational hardening (CI/CD, backups, graceful shutdown, health checks), and a small number of genuine correctness bugs in edge-case handling (delete-dedup collision, formatting conflict resolution, Unicode boundary handling) that are exactly the kind of thing this audit's recursive-questioning methodology was designed to surface. None of the findings indicate the fundamental architectural approach needs to be abandoned or re-platformed — they indicate a clear, prioritizable punch list before this system should carry real, non-trusted multi-user traffic.
