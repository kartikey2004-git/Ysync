// Cross-process fan-out ke liye transport. RoomManager apne room ke local
// ops/presence updates yahan publish karta hai, aur usi channel pe subscribed
// har process (production mein same Redis ke peeche baaki instances bhi)
// ko subscribe wale handler mein deliver ho jata hai.
//
// Interface isliye rakha hai taaki RoomManager ka multi-instance fan-out logic
// har test run mein real Redis maange bina in-process fake se test ho sake.
export interface PubSubBus {
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  close(): Promise<void>;
}
