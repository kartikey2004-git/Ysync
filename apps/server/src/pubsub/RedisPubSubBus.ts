import { Redis } from "ioredis";
import type { PubSubBus } from "./PubSubBus.js";

/**
 * Real Redis-backed PubSubBus (system-design.md §6.2). ioredis requires a
 * connection that has issued SUBSCRIBE to be used only for subscriber
 * commands, so publish and subscribe each get their own connection.
 */
export class RedisPubSubBus implements PubSubBus {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, (message: string) => void>();

  constructor(redisUrl: string) {
    this.publisher = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);
    this.subscriber.on("message", (channel: string, message: string) => {
      this.handlers.get(channel)?.(message);
    });
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.publisher.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.handlers.set(channel, handler);
    await this.subscriber.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.handlers.delete(channel);
    await this.subscriber.unsubscribe(channel);
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
