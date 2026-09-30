import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load root .env (two levels up from apps/server/src/)
const __dirname = fileURLToPath(new URL(".", import.meta.url));
config({ path: resolve(__dirname, "../../../.env") });

import { initTracing } from "./tracing.js";
initTracing();

import { createPrismaClient } from "@ysync/database";
import { createServer } from "./server.js";
import { createAuth } from "./auth/betterAuth.js";
import { AuthorizationService } from "./auth/authorizationService.js";
import { RedisPubSubBus } from "./pubsub/RedisPubSubBus.js";
import { RedisPresenceStore } from "./presence/RedisPresenceStore.js";
import { RedisSeqAllocator } from "./seq/RedisSeqAllocator.js";
import { PrismaPersistenceStore } from "./persistence/PrismaPersistenceStore.js";
import { logger, errorMeta } from "./logger.js";
import { resolveRequiredUrl } from "./config.js";
import { Redis } from "ioredis";
import * as metrics from "./metrics.js";

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", { error: errorMeta(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { error: errorMeta(err) });
});

const port = Number(process.env.PORT ?? 8080);
const redisUrl = resolveRequiredUrl("REDIS_URL", process.env.REDIS_URL, "redis://localhost:6379");
const databaseUrl = resolveRequiredUrl(
  "DATABASE_URL",
  process.env.DATABASE_URL,
  "postgresql://postgres:postgres@localhost:5432/ysync",
);

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
if (!allowedOrigins || allowedOrigins.length === 0) {
  logger.warn("ALLOWED_ORIGINS not set — WS origin checking is disabled, any origin can connect");
}

if (!process.env.BETTER_AUTH_SECRET && process.env.NODE_ENV === "production") {
  logger.error("BETTER_AUTH_SECRET is required in production");
  process.exit(1);
}

logger.info("ysync server bootstrap starting", {
  port,
  usingRedisUrlFromEnv: Boolean(process.env.REDIS_URL),
  usingDatabaseUrlFromEnv: Boolean(process.env.DATABASE_URL),
  allowedOrigins: allowedOrigins ?? "disabled",
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
});

// Single PrismaClient shared by persistence store, Better Auth, and authorization service
const prisma = createPrismaClient(databaseUrl);
const auth = createAuth(prisma);
const authorizationService = new AuthorizationService(prisma);

const pubSubBus = new RedisPubSubBus(redisUrl);
const presenceStore = new RedisPresenceStore(redisUrl);
const seqAllocator = new RedisSeqAllocator(redisUrl, {
  getLatestSeq: async (docId: string) => {
    const doc = await prisma.document.findUnique({
      where: { id: docId },
      select: { latestSeq: true },
    });
    return doc?.latestSeq ?? 0;
  },
});
const persistenceStore = new PrismaPersistenceStore(prisma);

const healthRedis = new Redis(redisUrl);
const healthCheck = async () => {
  const [pg, rd] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    healthRedis.ping(),
  ]);
  return { postgres: pg.status === "fulfilled", redis: rd.status === "fulfilled" };
};

const { httpServer, wss, roomManager } = createServer({
  pubSubBus,
  presenceStore,
  seqAllocator,
  persistenceStore,
  allowedOrigins,
  auth,
  authorizationService,
  prisma,
  healthCheck,
});

httpServer.listen(port, () => {
  logger.info("ysync server listening", { port });
});

// --- Graceful shutdown ---

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 10_000);
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown_started", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });

  const deadline = setTimeout(() => {
    logger.error("shutdown_timeout", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
    metrics.shutdowns.inc({ outcome: "timeout" });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  try {
    // 1. Stop accepting new WS connections and close existing ones
    wss.close();
    for (const client of wss.clients) {
      client.close(1001, "server shutting down");
    }
    logger.info("shutdown_draining", { step: "wss_closed" });

    // 2. Stop accepting new HTTP connections
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    logger.info("shutdown_draining", { step: "http_closed" });

    // 3. Close room manager (clears sweep timers)
    await roomManager.close();
    logger.info("shutdown_draining", { step: "rooms_closed" });

    // 4. Close all Redis connections
    await seqAllocator.close();
    await presenceStore.close();
    await pubSubBus.close();
    await healthRedis.quit();
    logger.info("shutdown_draining", { step: "redis_closed" });

    // 5. Disconnect Prisma
    await prisma.$disconnect();

    metrics.shutdowns.inc({ outcome: "complete" });
    logger.info("shutdown_complete", { signal });
    clearTimeout(deadline);
    process.exit(0);
  } catch (err) {
    logger.error("shutdown_error", { signal, error: errorMeta(err) });
    metrics.shutdowns.inc({ outcome: "error" });
    clearTimeout(deadline);
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
