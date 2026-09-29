// Concurrency ceiling ramp test.
//
// Unlike loadTest.ts (fixed client count, server in-process with the clients,
// single document), this spawns the server as its own OS process — so client
// socket/CPU work never contends with server work — and doubles the client
// count across many documents/rooms until something actually breaks:
// connect failures, broadcast latency blowing past target, or MAX_CLIENTS.
//
// Each stage also samples server-side resource usage (RSS, heap, event-loop
// lag, live connection count) reported by loadTestServer.ts, so the report
// shows *why* a stage failed, not just that it did.
//
// This measures a local-machine ceiling for the WS/pub-sub transport layer
// (persistence is in-memory — see loadTestServer.ts), not a production
// capacity guarantee. Run against real Redis (REDIS_URL) and on the actual
// deployment hardware for a number you'd trust in a capacity conversation.
//
// Env: START_CLIENTS (100), MAX_CLIENTS (4000), ROOMS (20), SAMPLE_ROOMS (5),
// ROUNDS_PER_STAGE (5), P95_TARGET_MS (200), CONNECT_TIMEOUT_MS (8000),
// CONNECT_FAILURE_THRESHOLD (0.02), LOCAL_ADDR_POOL_SIZE (1), REDIS_URL
// (optional, passed to server).
//
// LOCAL_ADDR_POOL_SIZE rotates outbound connections across loopback aliases
// (127.1.0.x, ...), which helps if the wall you hit is client-side ephemeral
// port exhaustion (error code EADDRNOTAVAIL). On Windows the wall we actually
// measured at ~16k connections was ENOBUFS instead — kernel socket-buffer
// exhaustion on this machine — and rotating source addresses had no effect on
// it, which is expected: ENOBUFS isn't a port problem. The connect-error
// breakdown the ramp prints per stage tells you which one you're looking at.
// Either way it's a client-machine ceiling, not evidence the server itself is
// struggling — check the server-side stats columns for that.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";
import type { ServerMessage } from "@ysync/protocol";

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 20000 + Math.floor(Math.random() * 10000);

const START_CLIENTS = Number(process.env.START_CLIENTS ?? 100);
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS ?? 4000);
const ROOMS = Number(process.env.ROOMS ?? 20);
const SAMPLE_ROOMS = Math.min(ROOMS, Number(process.env.SAMPLE_ROOMS ?? 5));
const ROUNDS_PER_STAGE = Number(process.env.ROUNDS_PER_STAGE ?? 5);
const P95_TARGET_MS = Number(process.env.P95_TARGET_MS ?? 200);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS ?? 8000);
const CONNECT_FAILURE_THRESHOLD = Number(process.env.CONNECT_FAILURE_THRESHOLD ?? 0.02);
const CONNECT_BATCH_SIZE = 200;

// The whole 127.0.0.0/8 block is loopback on both Windows and Linux, no interface config needed.
// A connection is identified by the full (localAddr, localPort, remoteAddr, remotePort) tuple, and
// every client here dials the same remote addr:port — so the OS's ~16k-port dynamic range is the
// real ceiling on distinct connections *per local address*. Rotating source IPs gives each one its
// own port budget, which is the only way to open more sockets than that from a single machine/process.
const LOCAL_ADDR_POOL_SIZE = Number(process.env.LOCAL_ADDR_POOL_SIZE ?? 1);
const localAddressPool = Array.from({ length: LOCAL_ADDR_POOL_SIZE }, (_, i) => {
  const b = Math.floor(i / 65536) + 1;
  const c = Math.floor(i / 256) % 256;
  const d = i % 256;
  return `127.${b}.${c}.${d}`;
});

interface StageStats {
  connections: number;
  rssMB: number;
  heapUsedMB: number;
  eventLoopLagMeanMs: number;
  eventLoopLagMaxMs: number;
}

let latestStats: StageStats | null = null;

function startServer(): Promise<ChildProcessWithoutNullStreams> {
  return new Promise((resolve, reject) => {
    const child = spawn("tsx", ["scripts/loadTestServer.ts"], {
      cwd: SERVER_DIR,
      // info-level logging on every connection/message is itself a bottleneck at thousands of
      // connections, and would skew the very numbers this test is trying to measure
      env: { ...process.env, PORT: String(PORT), LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" },
      shell: true,
    });

    let resolved = false;
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("STATS ")) {
          try {
            latestStats = JSON.parse(line.slice("STATS ".length)) as StageStats;
          } catch {
            // ignore a partial/corrupt line, next tick will have a fresh one
          }
        } else if (line.startsWith("READY ")) {
          resolved = true;
          resolve(child);
        } else if (line.trim().length > 0) {
          console.log(`[server] ${line}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk.toString()}`));
    child.on("exit", (code) => {
      if (!resolved) reject(new Error(`server process exited early with code ${code}`));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error("server did not become READY in time"));
    }, 15_000).unref();
  });
}

function connectClient(url: string, docId: string, replicaId: string, localAddress: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    const ws = new WebSocket(url, { localAddress });
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "join", docId, replicaId, sinceSeq: 0 }));
    });
    ws.once("message", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function connectInBatches(
  url: string,
  jobs: Array<{ docId: string; replicaId: string; roomIndex: number; localAddress: string }>,
  rooms: Map<number, WebSocket[]>,
  errorCounts: Map<string, number>,
): Promise<number> {
  let failures = 0;
  for (let i = 0; i < jobs.length; i += CONNECT_BATCH_SIZE) {
    const batch = jobs.slice(i, i + CONNECT_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((j) => connectClient(url, j.docId, j.replicaId, j.localAddress)),
    );
    results.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        const roomIndex = batch[idx]!.roomIndex;
        const arr = rooms.get(roomIndex) ?? [];
        arr.push(result.value);
        rooms.set(roomIndex, arr);
      } else {
        failures += 1;
        const err = result.reason as { code?: string; message?: string };
        const key = err?.code ?? err?.message ?? String(err);
        errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
      }
    });
  }
  return failures;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

async function runRound(docId: string, sender: WebSocket, receivers: WebSocket[], opCounter: number): Promise<number[]> {
  const sentAt = performance.now();
  return new Promise<number[]>((resolve) => {
    if (receivers.length === 0) {
      resolve([]);
      return;
    }
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
        docId,
        ops: [{ type: "insert", id: { counter: opCounter, replicaId: "ramp-sender" }, originId: null, value: "x" }],
      }),
    );
  });
}

async function sampleLatency(rooms: Map<number, WebSocket[]>): Promise<number[]> {
  const roomIndices = [...rooms.keys()].filter((i) => (rooms.get(i)?.length ?? 0) >= 2);
  const sampled = roomIndices.slice(0, SAMPLE_ROOMS);
  const latencies: number[] = [];
  let opCounter = 0;
  for (let round = 0; round < ROUNDS_PER_STAGE; round++) {
    for (const roomIndex of sampled) {
      const sockets = rooms.get(roomIndex)!;
      const sender = sockets[round % sockets.length]!;
      const receivers = sockets.filter((s) => s !== sender);
      const roundLatencies = await runRound(`ramp-room-${roomIndex}`, sender, receivers, ++opCounter);
      latencies.push(...roundLatencies);
    }
  }
  return latencies.sort((a, b) => a - b);
}

async function main(): Promise<void> {
  console.log("YSync concurrency ramp test");
  console.log(`start: ${START_CLIENTS}, max: ${MAX_CLIENTS}, rooms: ${ROOMS}, p95 target: ${P95_TARGET_MS}ms`);
  console.log("spawning server as a separate process...");

  const server = await startServer();
  const url = `ws://127.0.0.1:${PORT}`;
  const rooms = new Map<number, WebSocket[]>();

  let connected = 0;
  let target = START_CLIENTS;
  let lastHealthyStage: { connected: number; p50: number; p95: number; stats: StageStats | null } | null = null;
  let stopReason = "";

  try {
    while (true) {
      target = Math.min(target, MAX_CLIENTS);
      const delta = target - connected;
      if (delta > 0) {
        const jobs = Array.from({ length: delta }, (_, i) => {
          const globalIndex = connected + i;
          const roomIndex = globalIndex % ROOMS;
          const localAddress = localAddressPool[globalIndex % localAddressPool.length]!;
          return { docId: `ramp-room-${roomIndex}`, replicaId: `ramp-client-${globalIndex}`, roomIndex, localAddress };
        });
        const errorCounts = new Map<string, number>();
        const failures = await connectInBatches(url, jobs, rooms, errorCounts);
        const successful = delta - failures;
        connected += successful;
        const failureRate = failures / delta;

        if (failures > 0) {
          const breakdown = [...errorCounts.entries()].map(([code, n]) => `${code}=${n}`).join(", ");
          console.log(`  connect errors: ${breakdown}`);
        }

        if (failureRate > CONNECT_FAILURE_THRESHOLD) {
          stopReason = `connect failure rate ${(failureRate * 100).toFixed(1)}% at target ${target} (${failures}/${delta} failed) exceeded threshold`;
          console.log(`\nstage target=${target}: ${stopReason}`);
          break;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 300)); // let the server settle before sampling
      const latencies = await sampleLatency(rooms);
      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const max = latencies[latencies.length - 1] ?? 0;
      const stats = latestStats;

      console.log(
        `stage target=${target} connected=${connected} | latency p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms | ` +
          `server rss=${stats?.rssMB ?? "?"}MB heap=${stats?.heapUsedMB ?? "?"}MB loopLag(mean/max)=${stats?.eventLoopLagMeanMs ?? "?"}/${stats?.eventLoopLagMaxMs ?? "?"}ms conns=${stats?.connections ?? "?"}`,
      );

      if (p95 > P95_TARGET_MS) {
        stopReason = `p95 broadcast latency ${p95.toFixed(1)}ms exceeded ${P95_TARGET_MS}ms target at ${connected} connections`;
        console.log(`\n${stopReason}`);
        break;
      }

      lastHealthyStage = { connected, p50, p95, stats };

      if (target >= MAX_CLIENTS) {
        stopReason = `reached MAX_CLIENTS (${MAX_CLIENTS}) without finding a ceiling — raise MAX_CLIENTS to keep searching`;
        console.log(`\n${stopReason}`);
        break;
      }
      target *= 2;
    }
  } finally {
    console.log("\n--- summary ---");
    if (lastHealthyStage) {
      console.log(`last healthy stage: ${lastHealthyStage.connected} concurrent connections`);
      console.log(`  p50=${lastHealthyStage.p50.toFixed(1)}ms p95=${lastHealthyStage.p95.toFixed(1)}ms`);
      if (lastHealthyStage.stats) {
        console.log(
          `  server: rss=${lastHealthyStage.stats.rssMB}MB heap=${lastHealthyStage.stats.heapUsedMB}MB loopLag mean=${lastHealthyStage.stats.eventLoopLagMeanMs}ms`,
        );
      }
    } else {
      console.log("no stage completed successfully");
    }
    if (stopReason) console.log(`stopped because: ${stopReason}`);
    console.log("this is a local-machine, in-memory-persistence measurement — see script header for caveats");

    for (const sockets of rooms.values()) for (const ws of sockets) ws.terminate();
    server.kill();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
