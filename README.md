# YSync

A real-time collaborative text editor built on a custom sequence CRDT -
concurrent edits from any number of replicas converge without a central
lock, work fully offline, and reconcile with zero data loss on reconnect.

The CRDT is an RGA (Replicated Growable Array) variant, implemented as a
Timestamped Insertion (TI) List. The system it runs inside (the
WebSocket sync server, Postgres persistence, Redis fan-out, the Next.js
client). 

## Key features

- **Custom sequence CRDT** ([`packages/crdt`](./packages/crdt)) — an RGA
  implementation anchored by recorded origin ids (not live list
  positions), verified by property-based tests simulating thousands of
  out-of-order concurrent operations.
- **WebSocket sync server** ([`apps/server`](./apps/server)) — per-document
  awareness/presence (cursors, selections), fanning ops out to every
  connected client, horizontally scalable via Redis pub/sub across
  processes.
- **Offline-first sync** — local edits queue in IndexedDB and reconcile
  via CRDT causal ordering on reconnect (incremental `sync` when
  possible, a full snapshot fallback otherwise), validated by a scenario
  test driving concurrent offline edits across simulated clients.
- **Durable persistence** ([`packages/database`](./packages/database)) —
  the CRDT op log is persisted to Postgres with periodic snapshots and
  tombstone compaction, bounding the operation table's row count
  independent of total edit-history length.

## Architecture

```
apps/
  server/     WebSocket sync server (Express + ws, Redis, Prisma)
  web/        Next.js editor client (Quill, IndexedDB)
packages/
  crdt/       the sequence CRDT itself — no I/O, isomorphic
  protocol/   zod-validated WS message schemas shared by server + client
  database/   Prisma schema/client (Postgres)
```


## Getting started

### Prerequisites

Node 20+, npm, and Docker (for local Postgres + Redis).

### Setup

```bash
npm install

# Postgres + Redis (docker-compose.yml)
docker compose up -d

# apply the schema
cp .env.example .env
npm run db:migrate
```

### Running the app

In two separate terminals, with the env vars from `.env.example`
exported (or passed inline):

```bash
npm run dev --workspace=apps/server
```

```bash
npm run dev --workspace=apps/web
```

Open two browser tabs at the same `/doc/<slug>` on
[localhost:3000](http://localhost:3000/) — edits and presence sync live.
A "simulate offline" toggle in the editor lets you exercise the offline
reconnect path without actually disconnecting your network.

### Testing

```bash
npm test
```

Runs every workspace's test suite. Integration tests that need a real
Redis/Postgres (`*.integration.test.ts`) skip gracefully — not fail — if
`REDIS_URL`/`DATABASE_URL` aren't reachable, so `npm test` works without
Docker running; bring the compose stack up first to run the full set.

### Benchmarks

Not part of `npm test` — reports, not pass/fail gates (a regression from
the recorded baseline is a signal to investigate, not a CI failure):

```bash
npm run benchmark:storage -w apps/server   # op-log growth bound (docs/changes/phase-4-persistence.md)
npm run benchmark:latency -w apps/server   # WS fan-out propagation latency (docs/changes/phase-7-load-latency.md)
```

## Author

[Kartikey Bhatnagar](https://github.com/kartikey2004-git)
