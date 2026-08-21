import { describe, expect, test } from "vitest";
import { Redis } from "ioredis";
import { RedisPubSubBus } from "../src/pubsub/RedisPubSubBus.js";
import { RedisPresenceStore } from "../src/presence/RedisPresenceStore.js";
import { RedisSeqAllocator } from "../src/seq/RedisSeqAllocator.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

async function isRedisReachable(url: string): Promise<boolean> {
  const client = new Redis(url, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 500 });
  client.on("error", () => {}); // just checking reachability here; a failed connect is expected, not a crash
  try {
    await client.connect();
    await client.quit();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}

const redisAvailable = await isRedisReachable(REDIS_URL);

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Tests the real ioredis-backed adapters against a live Redis — the counterpart to the
// in-memory-fake tests everywhere else. Skips rather than fails if Redis isn't reachable
// at REDIS_URL, so running Docker/Redis isn't required for npm test.
describe.skipIf(!redisAvailable)("Redis-backed adapters (requires a live Redis at REDIS_URL)", () => {
  test("RedisPubSubBus delivers a publish to an independently-subscribed connection", async () => {
    const publisher = new RedisPubSubBus(REDIS_URL);
    const subscriber = new RedisPubSubBus(REDIS_URL);
    const channel = `test:pubsub:${Date.now()}`;

    let resolveReceived!: (value: string) => void;
    const received = new Promise<string>((resolve) => {
      resolveReceived = resolve;
    });
    // await subscribe() itself instead of a fixed sleep (ioredis resolves it only after
    // the SUBSCRIBE ack) — a blind sleep was exactly what made this test flaky during
    // Docker Desktop/WSL2's port-forward warm-up
    await subscriber.subscribe(channel, (message) => resolveReceived(message));
    await publisher.publish(channel, "hello");

    expect(await received).toBe("hello");

    await publisher.close();
    await subscriber.close();
  });

  test("RedisPubSubBus stops delivering after unsubscribe", async () => {
    const publisher = new RedisPubSubBus(REDIS_URL);
    const subscriber = new RedisPubSubBus(REDIS_URL);
    const channel = `test:pubsub:${Date.now()}`;
    const messages: string[] = [];

    let resolveFirst!: () => void;
    const firstReceived = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    await subscriber.subscribe(channel, (message) => {
      messages.push(message);
      resolveFirst();
    });
    await publisher.publish(channel, "first");
    await firstReceived;

    await subscriber.unsubscribe(channel);
    await publisher.publish(channel, "second");
    await wait(200); // confirming a message *doesn't* arrive genuinely needs a bounded wait here

    expect(messages).toEqual(["first"]);

    await publisher.close();
    await subscriber.close();
  });

  test("RedisPresenceStore set/list/sweep round-trips through real Redis", async () => {
    const store = new RedisPresenceStore(REDIS_URL);
    const docId = `test:doc:${Date.now()}`;

    await store.set(docId, { replicaId: "alice", cursor: 3 }, 10_000);
    expect(await store.list(docId)).toEqual([{ replicaId: "alice", cursor: 3 }]);

    await store.set(docId, { replicaId: "bob", cursor: 1 }, 10); // bob's 10ms TTL — expires quickly for the sweep test
    await wait(50);
    const expired = await store.sweep(docId);
    expect(expired).toEqual(["bob"]);
    expect(await store.list(docId)).toEqual([{ replicaId: "alice", cursor: 3 }]);

    await store.remove(docId, "alice");
    expect(await store.list(docId)).toEqual([]);

    await store.close();
  });

  test("RedisSeqAllocator increments monotonically and is shared across instances", async () => {
    const allocatorA = new RedisSeqAllocator(REDIS_URL);
    const allocatorB = new RedisSeqAllocator(REDIS_URL);
    const docId = `test:seq:${Date.now()}`;

    expect(await allocatorA.next(docId)).toBe(1);
    expect(await allocatorB.next(docId)).toBe(2);
    expect(await allocatorA.next(docId)).toBe(3);
    expect(await allocatorB.current(docId)).toBe(3);

    await allocatorA.close();
    await allocatorB.close();
  });
});
