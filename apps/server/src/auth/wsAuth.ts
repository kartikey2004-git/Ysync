import type { IncomingMessage } from "node:http";
import { fromNodeHeaders } from "better-auth/node";
import type { Auth } from "./betterAuth.js";

export interface AuthenticatedSocketState {
  userId: string;
  sessionId: string;
  docId: string;
  replicaId: string;
}

export async function authenticateWsUpgrade(
  auth: Auth,
  req: IncomingMessage,
): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (!session?.user?.id || !session.session?.id) return null;
    return { userId: session.user.id, sessionId: session.session.id };
  } catch {
    return null;
  }
}
