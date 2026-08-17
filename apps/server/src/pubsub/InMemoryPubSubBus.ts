import type { PubSubBus } from "./PubSubBus.js";

// Shared "wire" hai jispe multiple InMemoryPubSubBus instances point kar sakte hain,
// taaki real Redis ke bina hi kai server processes ek Redis se baat karne wala scene
// simulate ho jaye. Har InMemoryPubSubBus sirf apne pe registered handlers hi call karta hai,
// bilkul waise jaise alag-alag Redis client connections behave karte hain.
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
    // sirf apne handlers ko clear karo, broker shared hai toh dusre bus instances ko touch mat karo
    for (const [channel, handler] of this.handlers) {
      this.broker.unsubscribe(channel, handler);
    }
    this.handlers.clear();
  }
}
