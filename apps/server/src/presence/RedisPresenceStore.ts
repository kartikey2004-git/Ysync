import { Redis } from "ioredis";
import type { PresenceEntry, PresenceStore } from "./PresenceStore.js";

function dataKey(docId: string): string {
  return `presence:${docId}:data`;
}

function heartbeatKey(docId: string): string {
  return `presence:${docId}:heartbeat`;
}

/**
 * Redis-backed PresenceStore (system-design.md §6.5): a hash of
 * replicaId -> JSON payload, plus a sorted set of replicaId -> expiry
 * timestamp used to find and evict stale entries on `sweep`.
 */
export class RedisPresenceStore implements PresenceStore {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  async set(docId: string, entry: PresenceEntry, ttlMs: number): Promise<void> {
    await this.redis
      .multi()
      .hset(dataKey(docId), entry.replicaId, JSON.stringify(entry))
      .zadd(heartbeatKey(docId), Date.now() + ttlMs, entry.replicaId)
      .exec();
  }

  async remove(docId: string, replicaId: string): Promise<void> {
    await this.redis.multi().hdel(dataKey(docId), replicaId).zrem(heartbeatKey(docId), replicaId).exec();
  }

  async list(docId: string): Promise<PresenceEntry[]> {
    const liveReplicaIds = await this.redis.zrangebyscore(heartbeatKey(docId), Date.now(), "+inf");
    if (liveReplicaIds.length === 0) return [];
    const raw = await this.redis.hmget(dataKey(docId), ...liveReplicaIds);
    return raw.filter((value): value is string => value !== null).map((value) => JSON.parse(value) as PresenceEntry);
  }

  async sweep(docId: string): Promise<string[]> {
    const expired = await this.redis.zrangebyscore(heartbeatKey(docId), "-inf", Date.now());
    if (expired.length === 0) return [];
    await this.redis.multi().zrem(heartbeatKey(docId), ...expired).hdel(dataKey(docId), ...expired).exec();
    return expired;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
