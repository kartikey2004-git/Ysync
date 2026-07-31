import type { PubSubBus } from "./PubSubBus.js";

/**
 * Shared "wire" multiple `InMemoryPubSubBus` instances can be pointed at
 * to simulate several server processes talking to the same Redis, without
 * a real Redis. Each `InMemoryPubSubBus` only invokes handlers registered
 * on itself, matching how independent Redis client connections behave.
 */
export class InMemoryBroker {
  private readonly subscribers = new Map<string, Set<(message: string) => void>>();

  publish(channel: string, message: string): void {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) handler(message);
  }

  subscribe(channel: string, handler: (message: string) => void): void {
    let handlers = this.subscribers.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.subscribers.set(channel, handlers);
    }
    handlers.add(handler);
  }

  unsubscribe(channel: string, handler: (message: string) => void): void {
    this.subscribers.get(channel)?.delete(handler);
  }
}

export class InMemoryPubSubBus implements PubSubBus {
  private readonly broker: InMemoryBroker;
  private readonly handlers = new Map<string, (message: string) => void>();

  constructor(broker: InMemoryBroker = new InMemoryBroker()) {
    this.broker = broker;
  }

  async publish(channel: string, message: string): Promise<void> {
    this.broker.publish(channel, message);
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    this.handlers.set(channel, handler);
    this.broker.subscribe(channel, handler);
  }

  async unsubscribe(channel: string): Promise<void> {
    const handler = this.handlers.get(channel);
    if (handler) {
      this.broker.unsubscribe(channel, handler);
      this.handlers.delete(channel);
    }
  }

  async close(): Promise<void> {
    for (const [channel, handler] of this.handlers) {
      this.broker.unsubscribe(channel, handler);
    }
    this.handlers.clear();
  }
}
