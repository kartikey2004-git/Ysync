import { Redis } from "ioredis";
import type { PresenceEntry, PresenceStore } from "./PresenceStore.js";
import { logger, errorMeta } from "../logger.js";

function dataKey(docId: string): string {
  return `presence:${docId}:data`;
}

function heartbeatKey(docId: string): string {
  return `presence:${docId}:heartbeat`;
}

// Redis-backed PresenceStore: a hash of replicaId -> JSON payload, and a sorted set of replicaId -> expiry timestamp, so sweeping can find stale entries and drop them.
export class RedisPresenceStore implements PresenceStore {
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.redis.on("connect", () => logger.info("Redis presence store connected"));
    this.redis.on("reconnecting", () => logger.warn("Redis presence store reconnecting"));
    this.redis.on("end", () => logger.warn("Redis presence store connection ended"));
    this.redis.on("error", (err) => logger.error("Redis presence store connection error", { error: errorMeta(err) }));
  }

  async set(docId: string, entry: PresenceEntry, ttlMs: number): Promise<void> {
    // update the data hash and the heartbeat sorted-set together via multi() — otherwise a crash in between could leave data written but no expiry entry (or the reverse)
    await this.redis
      .multi()
      .hset(dataKey(docId), entry.replicaId, JSON.stringify(entry))
      .zadd(heartbeatKey(docId), Date.now() + ttlMs, entry.replicaId)
      .exec();
  }

  async remove(docId: string, replicaId: string): Promise<void> {
    await this.redis.multi().hdel(dataKey(docId), replicaId).zrem(heartbeatKey(docId), replicaId).exec();
  }

  // reads the heartbeat set first so expired-but-not-yet-swept replicaIds never leak back out through list(), even between sweep() runs
  async list(docId: string): Promise<PresenceEntry[]> {
    const liveReplicaIds = await this.redis.zrangebyscore(heartbeatKey(docId), Date.now(), "+inf");
    if (liveReplicaIds.length === 0) return [];
    const raw = await this.redis.hmget(dataKey(docId), ...liveReplicaIds);
    return raw.filter((value): value is string => value !== null).map((value) => JSON.parse(value) as PresenceEntry);
  }

  async sweep(docId: string): Promise<string[]> {
    // find who expired first, then remove them from both places — skip the Redis call entirely if nobody expired
    const expired = await this.redis.zrangebyscore(heartbeatKey(docId), "-inf", Date.now());
    if (expired.length === 0) return [];
    await this.redis.multi().zrem(heartbeatKey(docId), ...expired).hdel(dataKey(docId), ...expired).exec();
    return expired;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
