import { Redis } from "ioredis";
import type { SeqAllocator } from "./SeqAllocator.js";

function seqKey(docId: string): string {
  return `doc:${docId}:seq`;
}

export class RedisSeqAllocator implements SeqAllocator {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async next(docId: string): Promise<number> {
    return this.redis.incr(seqKey(docId));
  }

  async current(docId: string): Promise<number> {
    const value = await this.redis.get(seqKey(docId));
    return value ? Number(value) : 0;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
