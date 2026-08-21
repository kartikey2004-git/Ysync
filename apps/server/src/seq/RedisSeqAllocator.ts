import { Redis } from "ioredis";
import type { SeqAllocator } from "./SeqAllocator.js";
import { logger, errorMeta } from "../logger.js";

function seqKey(docId: string): string {
  return `doc:${docId}:seq`;
}

// Real Redis-backed SeqAllocator — INCR is atomic, so this is the single source of truth for a document's next seq that every process shares.
export class RedisSeqAllocator implements SeqAllocator {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.redis.on("connect", () => logger.info("Redis seq allocator connected"));
    this.redis.on("reconnecting", () => logger.warn("Redis seq allocator reconnecting"));
    this.redis.on("end", () => logger.warn("Redis seq allocator connection ended"));
    this.redis.on("error", (err) => logger.error("Redis seq allocator connection error", { error: errorMeta(err) }));
  }

  async next(docId: string): Promise<number> {
    return this.redis.incr(seqKey(docId));
  }

  async current(docId: string): Promise<number> {
    // if the key was never created (no op has landed yet) Redis returns null — treat that as seq 0
    const value = await this.redis.get(seqKey(docId));
    return value ? Number(value) : 0;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
