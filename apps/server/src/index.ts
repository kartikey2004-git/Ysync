import { createServer } from "./server.js";
import { RedisPubSubBus } from "./pubsub/RedisPubSubBus.js";
import { RedisPresenceStore } from "./presence/RedisPresenceStore.js";
import { RedisSeqAllocator } from "./seq/RedisSeqAllocator.js";
import { PrismaPersistenceStore } from "./persistence/PrismaPersistenceStore.js";
import { logger, errorMeta } from "./logger.js";
import { resolveRequiredUrl } from "./config.js";

// yeh last-resort safety net hai, primary fix nahi — server.ts already normal
// operation ke saare rejections pakad leta hai. Yeh bas kisi anjaan bug se poora
// instance girne se bacha raha hai (Node 15+ default mein unhandled rejection pe process kill kar deta hai)
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

// comma-separated allowlist — unset/empty rehta hai toh origin check disabled
// hi rehta hai (BUG-008), koi breaking change nahi bina opt-in ke
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);
if (!allowedOrigins || allowedOrigins.length === 0) {
  logger.warn("ALLOWED_ORIGINS not set — WS origin checking is disabled, any origin can connect");
}

// REDIS_URL/DATABASE_URL ko kabhi raw log mat karo — dono mein password embed ho
// sakta hai (jaise redis://:PASSWORD@host:port). Sirf itna log karo ki env se aaya ya default use hua.
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
