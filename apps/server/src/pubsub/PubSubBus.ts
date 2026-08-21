// Transport for cross-process fan-out. RoomManager publishes its room's local ops/presence updates here, and every process subscribed to that channel (in production, the other instances behind the same Redis) gets it delivered to their subscribe handler.

// This is an interface so RoomManager's multi-instance fan-out logic can be tested with an in-process fake instead of requiring a real Redis on every test run.
export interface PubSubBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}
