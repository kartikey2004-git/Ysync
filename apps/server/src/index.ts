import { createServer } from "./server.js";
import { RedisPubSubBus } from "./pubsub/RedisPubSubBus.js";
import { RedisPresenceStore } from "./presence/RedisPresenceStore.js";
import { RedisSeqAllocator } from "./seq/RedisSeqAllocator.js";
import { PrismaPersistenceStore } from "./persistence/PrismaPersistenceStore.js";
import { logger, errorMeta } from "./logger.js";
import { resolveRequiredUrl } from "./config.js";

// this is a last-resort safety net, not the primary fix — server.ts already catches every rejection from normal operation. This just stops an unknown bug from taking down the whole instance (Node 15+ kills the process on an unhandled rejection by default)
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

// comma-separated allowlist — left unset/empty, origin checking stays disabled, so this is no breaking change without an explicit opt-in
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
if (!allowedOrigins || allowedOrigins.length === 0) {
  logger.warn("ALLOWED_ORIGINS not set — WS origin checking is disabled, any origin can connect");
}

// never log REDIS_URL/DATABASE_URL raw — both can have a password embedded (e.g. redis://:PASSWORD@host:port). Only log whether it came from env or fell back to the default.
logger.info("ysync server bootstrap starting", {
  port,
  usingRedisUrlFromEnv: Boolean(process.env.REDIS_URL),
  usingDatabaseUrlFromEnv: Boolean(process.env.DATABASE_URL),
  allowedOrigins: allowedOrigins ?? "disabled",
});

const { httpServer } = createServer({
  pubSubBus: new RedisPubSubBus(redisUrl),
  presenceStore: new RedisPresenceStore(redisUrl),
  seqAllocator: new RedisSeqAllocator(redisUrl),
  persistenceStore: new PrismaPersistenceStore(databaseUrl),
  allowedOrigins,
});

httpServer.listen(port, () => {
  logger.info("ysync server listening", { port });
});
