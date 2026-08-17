import { Redis } from "ioredis";
import type { PresenceEntry, PresenceStore } from "./PresenceStore.js";
import { logger, errorMeta } from "../logger.js";

function dataKey(docId: string): string {
  return `presence:${docId}:data`;
}

function heartbeatKey(docId: string): string {
  return `presence:${docId}:heartbeat`;
}

// Redis-backed PresenceStore: ek hash hai replicaId -> JSON payload, aur ek
// sorted set replicaId -> expiry timestamp, jisse sweep karte waqt stale entries dhoond ke hata sakein.
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
    // data hash aur heartbeat sorted-set dono ek saath multi() se update karo,
    // warna beech mein crash hua toh data hoga par expiry entry nahi (ya ulta)
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
    // pehle dhoondo kaun expire hua, phir dono jagah se hatao — koi expired nahi mila toh Redis call skip
    const expired = await this.redis.zrangebyscore(heartbeatKey(docId), "-inf", Date.now());
    if (expired.length === 0) return [];
    await this.redis.multi().zrem(heartbeatKey(docId), ...expired).hdel(dataKey(docId), ...expired).exec();
    return expired;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
