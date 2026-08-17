import { Redis } from "ioredis";
import type { PubSubBus } from "./PubSubBus.js";
import { logger, errorMeta } from "../logger.js";

// Real Redis wala PubSubBus. ioredis mein jis connection ne SUBSCRIBE call kar diya,
// woh sirf subscriber commands hi handle kar sakta hai — isliye publish aur
// subscribe dono ke alag connections rakhne pade.
export class RedisPubSubBus implements PubSubBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, (message: string) => void>();

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);

    this.publisher.on("connect", () => logger.info("Redis pubsub publisher connected"));
    this.publisher.on("reconnecting", () => logger.warn("Redis pubsub publisher reconnecting"));
    this.publisher.on("end", () => logger.warn("Redis pubsub publisher connection ended"));
    this.publisher.on("error", (err) => logger.error("Redis pubsub publisher connection error", { error: errorMeta(err) }));

    this.subscriber.on("connect", () => logger.info("Redis pubsub subscriber connected"));
    this.subscriber.on("reconnecting", () => logger.warn("Redis pubsub subscriber reconnecting"));
    this.subscriber.on("end", () => logger.warn("Redis pubsub subscriber connection ended"));
    this.subscriber.on("error", (err) => logger.error("Redis pubsub subscriber connection error", { error: errorMeta(err) }));

    this.subscriber.on("message", (channel: string, message: string) => {
      logger.debug("pub/sub message received", { channel, messageBytes: message.length });
      this.handlers.get(channel)?.(message);
    });
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.publisher.publish(channel, message);
    logger.debug("pub/sub message published", { channel, messageBytes: message.length });
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.handlers.set(channel, handler);
    await this.subscriber.subscribe(channel);
    logger.info("pub/sub subscription created", { channel });
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    await this.subscriber.unsubscribe(channel);
    logger.info("pub/sub subscription removed", { channel });
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
