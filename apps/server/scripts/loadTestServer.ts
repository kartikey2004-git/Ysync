// Standalone server process for the concurrency ramp test (loadTestRamp.ts).
//
// Runs in its own OS process so the ramp driver's client-side socket/CPU work
// never contends with the server's event loop — unlike loadTest.ts, which
// boots the server in-process alongside the clients.
//
// Prints a single "READY <port>" line once listening, then one "STATS {...}"
// JSON line per second with connection count, memory, and event-loop lag, so
// the driver can sample server-side resource usage without an extra HTTP hop.
//
// Env: PORT (required), REDIS_URL (optional — falls back to in-memory pub/sub
// / presence / seq allocator if unset or unreachable, same as loadTest.ts).
// Persistence is always in-memory: this measures the WS/pub-sub transport
// ceiling, not database throughput.

import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer } from "../src/server.js";
import { RedisPubSubBus } from "../src/pubsub/RedisPubSubBus.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { RedisPresenceStore } from "../src/presence/RedisPresenceStore.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { RedisSeqAllocator } from "../src/seq/RedisSeqAllocator.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import Redis from "ioredis";

const PORT = Number(process.env.PORT);
if (!PORT) {
  console.error("PORT env var is required");
  process.exit(1);
}
const REDIS_URL = process.env.REDIS_URL;

async function isRedisReachable(url: string): Promise<boolean> {
  const client = new Redis(url, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 500 });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.quit();
    return true;
  } catch {
    client.disconnect();
    return false;
  }
}

async function main(): Promise<void> {
  const useRedis = REDIS_URL ? await isRedisReachable(REDIS_URL) : false;
  const pubSubBus = useRedis ? new RedisPubSubBus(REDIS_URL as string) : new InMemoryPubSubBus();
  const presenceStore = useRedis ? new RedisPresenceStore(REDIS_URL as string) : new InMemoryPresenceStore();
  const seqAllocator = useRedis ? new RedisSeqAllocator(REDIS_URL as string) : new InMemorySeqAllocator();

  const server = createServer({
    pubSubBus,
    presenceStore,
    seqAllocator,
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 3_600_000,
  });

  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();

  await new Promise<void>((resolve) => server.httpServer.listen(PORT, resolve));

  console.log(`READY ${PORT}`);
  console.log(`backend: ${useRedis ? "real Redis" : "in-memory (Redis not reachable/configured)"}`);

  setInterval(() => {
    const mem = process.memoryUsage();
    const stats = {
      connections: server.wss.clients.size,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
      eventLoopLagMeanMs: Math.round((eventLoopDelay.mean / 1e6) * 10) / 10,
      eventLoopLagMaxMs: Math.round((eventLoopDelay.max / 1e6) * 10) / 10,
    };
    eventLoopDelay.reset();
    console.log(`STATS ${JSON.stringify(stats)}`);
  }, 1000).unref();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
