import { Registry, Gauge, Counter, Histogram } from "prom-client";

export const register = new Registry();

register.setDefaultLabels({ app: "ysync" });

const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

// --- Gauges ---

export const activeWsConnections = new Gauge({
  name: "ysync_active_ws_connections",
  help: "Number of active WebSocket connections",
  registers: [register],
});

export const activeRooms = new Gauge({
  name: "ysync_active_rooms",
  help: "Number of active rooms in memory",
  registers: [register],
});

// --- Counters ---

export const opsReceived = new Counter({
  name: "ysync_ops_received_total",
  help: "Total number of client operations received",
  registers: [register],
});

export const opsPersisted = new Counter({
  name: "ysync_ops_persisted_total",
  help: "Total number of operations persisted to database",
  registers: [register],
});

export const opsBroadcast = new Counter({
  name: "ysync_ops_broadcast_total",
  help: "Total number of operations broadcast to clients",
  registers: [register],
});

export const reconnects = new Counter({
  name: "ysync_reconnects_total",
  help: "Total number of duplicate replicaId reconnections",
  registers: [register],
});

export const snapshots = new Counter({
  name: "ysync_snapshots_total",
  help: "Total number of room snapshots persisted",
  registers: [register],
});

export const presenceUpdates = new Counter({
  name: "ysync_presence_updates_total",
  help: "Total number of presence updates processed",
  registers: [register],
});

export const errors = new Counter({
  name: "ysync_errors_total",
  help: "Total number of errors by stage",
  labelNames: ["stage"] as const,
  registers: [register],
});

export const shutdowns = new Counter({
  name: "ysync_shutdown_total",
  help: "Total shutdown attempts by outcome",
  labelNames: ["outcome"] as const,
  registers: [register],
});

export const duplicateOps = new Counter({
  name: "ysync_duplicate_ops_total",
  help: "Total number of duplicate operations skipped by persistence",
  registers: [register],
});

export const persistenceFailures = new Counter({
  name: "ysync_persistence_failures_total",
  help: "Total persistence failures",
  registers: [register],
});

export const roomLoadFailures = new Counter({
  name: "ysync_room_load_failures_total",
  help: "Total room load failures",
  registers: [register],
});

export const roomLoadsDeduped = new Counter({
  name: "ysync_room_loads_deduped_total",
  help: "Total room load calls that joined an in-flight load instead of starting a new one",
  registers: [register],
});

export const sequenceSeeds = new Counter({
  name: "ysync_sequence_seeds_total",
  help: "Total sequence counter seeds from PostgreSQL after Redis miss",
  registers: [register],
});

export const sequenceSeedFailures = new Counter({
  name: "ysync_sequence_seed_failures_total",
  help: "Total failures when seeding sequence counter from PostgreSQL",
  registers: [register],
});

// --- Histograms ---

export const opPersistDuration = new Histogram({
  name: "ysync_op_persist_duration_seconds",
  help: "Time to persist an operation to the database",
  buckets: DURATION_BUCKETS,
  registers: [register],
});

export const opBroadcastDuration = new Histogram({
  name: "ysync_op_broadcast_duration_seconds",
  help: "Time to broadcast an operation to local clients",
  buckets: DURATION_BUCKETS,
  registers: [register],
});

export const redisOperationDuration = new Histogram({
  name: "ysync_redis_operation_duration_seconds",
  help: "Time for Redis operations",
  labelNames: ["operation"] as const,
  buckets: DURATION_BUCKETS,
  registers: [register],
});
