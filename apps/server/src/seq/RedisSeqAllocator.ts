import { Redis } from "ioredis";
import type { SeqAllocator } from "./SeqAllocator.js";
import { logger, errorMeta } from "../logger.js";

function seqKey(docId: string): string {
  return `doc:${docId}:seq`;
}

// Real Redis wala SeqAllocator — INCR atomic hota hai, isliye document ka
// next seq nikalne ke liye yahi ek single source of truth hai jise har process share karta hai.
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
    // key kabhi bana hi nahi (koi op abhi tak nahi aaya) toh Redis null dega — us case mein 0 seq treat karo
    const value = await this.redis.get(seqKey(docId));
    return value ? Number(value) : 0;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
