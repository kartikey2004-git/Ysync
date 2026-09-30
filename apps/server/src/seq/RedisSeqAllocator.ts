import { Redis } from "ioredis";
import type { SeqAllocator } from "./SeqAllocator.js";
import { logger, errorMeta } from "../logger.js";
import * as metrics from "../metrics.js";

function seqKey(docId: string): string {
  return `doc:${docId}:seq`;
}

export interface RedisSeqAllocatorOptions {
  getLatestSeq?: (docId: string) => Promise<number>;
}

// Lua script: atomically seeds the counter from a durable floor.
// If the current value is below the floor, sets it to floor+1 and returns floor+1.
// Otherwise INCRs from the current value and returns the result.
// This prevents two servers from both seeding and producing duplicate seqs.
const SEED_SCRIPT = `
local key = KEYS[1]
local floor = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', key) or '0')
if current <= floor then
  local next = floor + 1
  redis.call('SET', key, tostring(next))
  return next
else
  return redis.call('INCR', key)
end
`;

// Redis-backed SeqAllocator with durable seeding from PostgreSQL.
//
// Invariant: Redis may accelerate sequence allocation, but PostgreSQL
// remains the durable source of truth. If the Redis counter is missing
// or behind the DB's latestSeq, it is atomically seeded forward before
// returning the next value.
export class RedisSeqAllocator implements SeqAllocator {
  private readonly redis: Redis;
  private readonly getLatestSeq?: (docId: string) => Promise<number>;

  constructor(redisUrl: string, options?: RedisSeqAllocatorOptions) {
    this.redis = new Redis(redisUrl);
    this.getLatestSeq = options?.getLatestSeq;
    this.redis.on("connect", () => logger.info("Redis seq allocator connected"));
    this.redis.on("reconnecting", () => logger.warn("Redis seq allocator reconnecting"));
    this.redis.on("end", () => logger.warn("Redis seq allocator connection ended"));
    this.redis.on("error", (err) => logger.error("Redis seq allocator connection error", { error: errorMeta(err) }));
  }

  async next(docId: string): Promise<number> {
    const seq = await this.redis.incr(seqKey(docId));

    // Fast path: counter already existed and is > 1 — no seeding needed
    if (seq !== 1 || !this.getLatestSeq) return seq;

    // seq === 1 means this key was just created (or Redis restarted).
    // Check the durable floor from PostgreSQL.
    let dbLatestSeq: number;
    try {
      dbLatestSeq = await this.getLatestSeq(docId);
    } catch (err) {
      metrics.sequenceSeedFailures.inc();
      logger.error("sequence_seed_failed", { docId, error: errorMeta(err) });
      // Can't verify — return 1 and hope for the best. The GREATEST
      // clause in appendOps prevents latestSeq from regressing in PG.
      return seq;
    }

    if (dbLatestSeq <= 0) return seq;

    // DB has ops at a higher seq — seed Redis atomically
    logger.info("sequence_seed_started", { docId, dbLatestSeq });
    try {
      const result = await this.redis.eval(
        SEED_SCRIPT,
        1,
        seqKey(docId),
        String(dbLatestSeq),
      ) as number;
      metrics.sequenceSeeds.inc();
      logger.info("sequence_seed_completed", { docId, dbLatestSeq, newSeq: result });
      return result;
    } catch (err) {
      metrics.sequenceSeedFailures.inc();
      logger.error("sequence_seed_failed", { docId, dbLatestSeq, error: errorMeta(err) });
      // Fallback: the INCR already returned 1 — this is unsafe if DB
      // has higher seqs, but appendOps's GREATEST prevents regression.
      return seq;
    }
  }

  async current(docId: string): Promise<number> {
    const value = await this.redis.get(seqKey(docId));
    return value ? Number(value) : 0;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
