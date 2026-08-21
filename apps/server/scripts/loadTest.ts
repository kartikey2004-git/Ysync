// Load / propagation-latency benchmark.

// Spins up a real WS server (in-process, on an ephemeral port) and connects a large number of concurrent real WebSocket clients to the same document. Each client takes a turn sending an op; the time for every other connected client to receive the broadcast-op is recorded.

// Prints p50 / p95 / max / avg at the end, against a sub-20ms server-side propagation target. Env vars: LOAD_TEST_CLIENTS (default 60), LOAD_TEST_ROUNDS (default 30), REDIS_URL (optional — uses the real Redis pub/sub bus if reachable, otherwise falls back to the in-memory one and says so in the report).

import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { ServerMessage } from "@ysync/protocol";
import { createServer, type YSyncServer } from "../src/server.js";
import { RedisPubSubBus } from "../src/pubsub/RedisPubSubBus.js";
import { InMemoryPubSubBus } from "../src/pubsub/InMemoryPubSubBus.js";
import { RedisPresenceStore } from "../src/presence/RedisPresenceStore.js";
import { InMemoryPresenceStore } from "../src/presence/InMemoryPresenceStore.js";
import { RedisSeqAllocator } from "../src/seq/RedisSeqAllocator.js";
import { InMemorySeqAllocator } from "../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../src/persistence/InMemoryPersistenceStore.js";
import Redis from "ioredis";

const CLIENT_COUNT = Number(process.env.LOAD_TEST_CLIENTS ?? 60);
const ROUNDS = Number(process.env.LOAD_TEST_ROUNDS ?? 30);
const DOC_ID = "load-test-doc";
const REDIS_URL = process.env.REDIS_URL;

async function isRedisReachable(url: string): Promise<boolean> {
  const client = new Redis(url, { lazyConnect: true, retryStrategy: () => null, connectTimeout: 500 });
  
  // this error listener is intentionally empty — Redis being unreachable is an expected outcome here, not a crash
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

function connectClient(url: string, replicaId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "join", docId: DOC_ID, replicaId, sinceSeq: 0 }));
    });
    ws.once("message", () => resolve(ws)); // the first message is always the join reply (sync/snapshot)
    ws.once("error", reject);
  });
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

async function runRound(sender: WebSocket, receivers: WebSocket[], opCounter: number, value: string): Promise<number[]> {
  const sentAt = performance.now();

  return new Promise<number[]>((resolve) => {
    const times: number[] = [];
    let remaining = receivers.length;

    for (const receiver of receivers) {
      const handler = (data: Buffer): void => {
        const message = JSON.parse(data.toString()) as ServerMessage;
        if (message.type === "broadcast-op") {
          times.push(performance.now() - sentAt);
          receiver.off("message", handler);
          remaining -= 1;
          if (remaining === 0) resolve(times);
        }
      };
      receiver.on("message", handler);
    }

    sender.send(
      JSON.stringify({
        type: "op",
        docId: DOC_ID,
        ops: [{ type: "insert", id: { counter: opCounter, replicaId: "load-test-sender" }, originId: null, value }],
      }),
    );
  });
}

async function main(): Promise<void> {
  const useRedis = REDIS_URL ? await isRedisReachable(REDIS_URL) : false;
  const pubSubBus = useRedis ? new RedisPubSubBus(REDIS_URL as string) : new InMemoryPubSubBus();
  const presenceStore = useRedis ? new RedisPresenceStore(REDIS_URL as string) : new InMemoryPresenceStore();
  const seqAllocator = useRedis ? new RedisSeqAllocator(REDIS_URL as string) : new InMemorySeqAllocator();

  const server: YSyncServer = createServer({
    pubSubBus,
    presenceStore,
    seqAllocator,
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
  });

  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const address = server.httpServer.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  console.log("YSync load/latency benchmark");
  
  console.log(`pub/sub backend: ${useRedis ? "real Redis" : "in-memory (Redis not reachable/configured)"}`);
  console.log(`clients: ${CLIENT_COUNT}, rounds: ${ROUNDS}`);

  const clients = await Promise.all(
    Array.from({ length: CLIENT_COUNT }, (_, i) => connectClient(url, `load-client-${i}`)),
  );
  console.log(`all ${CLIENT_COUNT} clients joined "${DOC_ID}"`);

  const latencies: number[] = [];
  let opCounter = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const sender = clients[round % clients.length] as WebSocket;
    const receivers = clients.filter((c) => c !== sender);
    const value = String.fromCharCode(97 + (round % 26));

    const roundLatencies = await runRound(sender, receivers, ++opCounter, value);
    latencies.push(...roundLatencies);
  }

  latencies.sort((a, b) => a - b);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const max = latencies[latencies.length - 1] ?? 0;
  const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;

  console.log("");
  console.log(`samples: ${latencies.length} (${ROUNDS} rounds x ${CLIENT_COUNT - 1} receivers)`);
  console.log(`p50: ${p50.toFixed(2)}ms`);
  console.log(`p95: ${p95.toFixed(2)}ms`);
  console.log(`max: ${max.toFixed(2)}ms`);
  console.log(`avg: ${avg.toFixed(2)}ms`);
  console.log(`sub-20ms target at p95: ${p95 < 20 ? "MET" : "NOT MET"}`);

  for (const client of clients) client.close();

  // each client closing triggers an async server-side `leave` (removing presence + a pub/sub publish), and the WS close event itself doesn't await that — give the in-flight publishes a moment to land, otherwise closing the shared Redis connections below would cut them off mid-flight
  await new Promise<void>((resolve) => setTimeout(resolve, 200));

  await server.roomManager.close();
  await new Promise<void>((resolve) => server.wss.close(() => resolve()));
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  await pubSubBus.close();
  await presenceStore.close();
  await seqAllocator.close();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
