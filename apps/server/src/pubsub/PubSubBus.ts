/**
 * Cross-process fan-out transport. `RoomManager` publishes a room's local
 * ops/presence updates here, and every process subscribed to the same
 * channel (including other processes behind the same Redis, in production)
 * gets them delivered to `subscribe`'s handler.
 *
 * Kept as an interface so the multi-instance fan-out logic in RoomManager
 * can be tested with an in-process fake instead of requiring a live Redis
 * for every test run — see docs/changes/phase-3-server-core.md.
 */
export interface PubSubBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}
