# Change: Phase 2 — `packages/protocol`

Ref: [plan.md](../../plan.md) Phase 2, [system-design.md](../../system-design.md) §5.

## What this change does

Adds the `packages/protocol` workspace: zod schemas (and their inferred TS
types) for every WebSocket message in the client↔server wire protocol,
plus a single validated entry point per direction (`parseClientMessage`,
`parseServerMessage`). `apps/server` and `apps/web` will both import from
here in later phases — this is what makes the protocol type-safe end to
end rather than two hand-maintained copies that can drift.

Depends on `@ysync/crdt` (workspace dependency) for `Op`/`OpId`/`FormatMark`
— the `Op` schema mirrors those types exactly rather than redefining a
parallel CRDT vocabulary.

No networking, no server, no client wiring in this change — schemas and
tests only.

## Files to add

- `packages/protocol/package.json`, `tsconfig.json`, `vitest.config.ts`.
- `packages/protocol/src/op.ts` — `formatMarkSchema`, `opIdSchema`,
  `insertOpSchema`, `deleteOpSchema`, `opSchema` (discriminated union on
  `type`).
- `packages/protocol/src/rgaSnapshot.ts` — `rgaSnapshotNodeSchema`,
  mirroring `@ysync/crdt`'s `RgaSnapshotNode` (needed for the `snapshot`
  server message).
- `packages/protocol/src/messages.ts` — every message schema from
  system-design.md §5:
  - client → server: `join`, `op`, `presence`, `leave`
  - server → client: `snapshot`, `sync`, `ack`, `broadcast-op`,
    `presence-update`, `presence-leave`, `error`
  - `clientMessageSchema` / `serverMessageSchema` discriminated unions over
    all of the above, plus their inferred TS types.
- `packages/protocol/src/parse.ts` — `parseClientMessage(raw: unknown)` /
  `parseServerMessage(raw: unknown)`, each returning a
  `{ success: true; data } | { success: false; error: string }` result
  (never throws — this is the boundary untrusted WS input crosses, per
  system-design.md §10, so it must degrade to a typed error, not an
  exception).
- `packages/protocol/src/index.ts` — public exports.
- `packages/protocol/test/protocol.test.ts`:
  - round-trip test for every message type (`encode → JSON.stringify →
    JSON.parse → parse* → deepEqual` against the original).
  - rejection tests for malformed input (missing field, wrong `type`
    literal, unknown `type`).
  - a cross-package sanity check: generate real `Op`s via `@ysync/crdt`'s
    `Rga.localInsert`/`localDelete` and confirm they validate against
    `opSchema` — catches the two packages' shapes drifting apart.

## Exit criteria

- `npm test -w packages/protocol` passes.
- `npm run build -w packages/protocol` (tsc) is clean.
- No message type from system-design.md §5 is missing a schema.
