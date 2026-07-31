import { createServer } from "./server.js";
import { RedisPubSubBus } from "./pubsub/RedisPubSubBus.js";
import { RedisPresenceStore } from "./presence/RedisPresenceStore.js";
import { RedisSeqAllocator } from "./seq/RedisSeqAllocator.js";

const port = Number(process.env.PORT ?? 8080);
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const { httpServer } = createServer({
  pubSubBus: new RedisPubSubBus(redisUrl),
  presenceStore: new RedisPresenceStore(redisUrl),
  seqAllocator: new RedisSeqAllocator(redisUrl),
});

httpServer.listen(port, () => {
  console.log(`ysync server listening on :${port} (redis: ${redisUrl})`);
});
