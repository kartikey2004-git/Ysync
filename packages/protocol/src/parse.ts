import type { z } from "zod";
import { clientMessageSchema, serverMessageSchema, type ClientMessage, type ServerMessage } from "./messages.js";

export type ParseResult<T> = { success: true; data: T } | { success: false; error: string };

function toParseResult<T>(result: z.SafeParseReturnType<unknown, T>): ParseResult<T> {
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error.message };
}

// WS boundary paar karke server mein aane wala untrusted input validate karta hai — kabhi throw nahi karta
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  return toParseResult(clientMessageSchema.safeParse(raw));
}

// WS boundary paar karke client mein aane wala untrusted input validate karta hai — kabhi throw nahi karta
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
  return toParseResult(serverMessageSchema.safeParse(raw));
}
