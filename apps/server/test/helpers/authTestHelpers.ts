import { WebSocket } from "ws";
import type { ServerMessage } from "@ysync/protocol";
import { createPrismaClient, type PrismaClient } from "@ysync/database";
import { createServer, type YSyncServer } from "../../src/server.js";
import { createAuth } from "../../src/auth/betterAuth.js";
import { AuthorizationService } from "../../src/auth/authorizationService.js";
import { InMemoryPubSubBus } from "../../src/pubsub/InMemoryPubSubBus.js";
import { InMemoryPresenceStore } from "../../src/presence/InMemoryPresenceStore.js";
import { InMemorySeqAllocator } from "../../src/seq/InMemorySeqAllocator.js";
import { InMemoryPersistenceStore } from "../../src/persistence/InMemoryPersistenceStore.js";
import type { AddressInfo } from "node:net";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/ysync";

// Better Auth needs a secret for cookie signing — set a deterministic test value
if (!process.env.BETTER_AUTH_SECRET) {
  process.env.BETTER_AUTH_SECRET = "ysync-test-secret-do-not-use-in-production";
}

export async function isPostgresReachable(): Promise<boolean> {
  const prisma = createPrismaClient(DATABASE_URL);
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

export interface TestServerContext {
  server: YSyncServer;
  httpUrl: string;
  wsUrl: string;
  prisma: PrismaClient;
  authorizationService: AuthorizationService;
  cleanup: () => Promise<void>;
}

export async function startAuthServer(): Promise<TestServerContext> {
  const prisma = createPrismaClient(DATABASE_URL);

  const auth = createAuth(prisma);
  const authorizationService = new AuthorizationService(prisma);

  const server = createServer({
    pubSubBus: new InMemoryPubSubBus(),
    presenceStore: new InMemoryPresenceStore(),
    seqAllocator: new InMemorySeqAllocator(),
    persistenceStore: new InMemoryPersistenceStore(),
    sweepIntervalMs: 60_000,
    idleTimeoutMs: 60_000,
    auth,
    prisma,
    authorizationService,
  });

  await new Promise<void>((resolve) => server.httpServer.listen(0, resolve));
  const address = server.httpServer.address() as AddressInfo;
  const httpUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}`;

  // Set BETTER_AUTH_URL to match the test server so cookies resolve correctly
  process.env.BETTER_AUTH_URL = httpUrl;

  const cleanup = async () => {
    await server.roomManager.close();
    await new Promise<void>((resolve) => server.wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
    await prisma.$disconnect();
  };

  return { server, httpUrl, wsUrl, prisma, authorizationService, cleanup };
}

export async function createTestUser(
  httpUrl: string,
  email: string,
  password: string,
  name: string,
): Promise<string> {
  const res = await fetch(`${httpUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
    redirect: "manual",
  });

  const cookies = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = cookies.find((c) => c.startsWith("ysync.session_token="));

  if (!sessionCookie) {
    const body = await res.text();
    throw new Error(`sign-up failed for ${email}: status=${res.status}, body=${body}`);
  }

  return sessionCookie.split(";")[0]!;
}

export async function signIn(
  httpUrl: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${httpUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });

  const cookies = res.headers.getSetCookie?.() ?? [];
  const sessionCookie = cookies.find((c) => c.startsWith("ysync.session_token="));

  if (!sessionCookie) {
    const body = await res.text();
    throw new Error(`sign-in failed for ${email}: status=${res.status}, body=${body}`);
  }

  return sessionCookie.split(";")[0]!;
}

export async function authenticatedFetch(
  httpUrl: string,
  path: string,
  cookie: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${httpUrl}${path}`, {
    ...options,
    headers: {
      ...Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([k, v]) => [k, String(v)]),
      ),
      Cookie: cookie,
    },
  });
}

export async function createDocumentAsUser(
  httpUrl: string,
  cookie: string,
): Promise<string> {
  const res = await authenticatedFetch(httpUrl, "/api/documents", cookie, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`create document failed: status=${res.status}, body=${body}`);
  }

  const body = (await res.json()) as { id: string };
  return body.id;
}

export function connectWs(url: string, options?: WebSocket.ClientOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) => {
      reject(new Error(`WS upgrade rejected: ${res.statusCode}`));
    });
  });
}

export function connectAuthenticatedWs(wsUrl: string, cookie: string): Promise<WebSocket> {
  return connectWs(wsUrl, { headers: { Cookie: cookie } });
}

export function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as ServerMessage));
  });
}

export function sendWs(socket: WebSocket, message: unknown): void {
  socket.send(JSON.stringify(message));
}

export async function joinDocument(
  socket: WebSocket,
  docId: string,
  replicaId: string,
  sinceSeq = 0,
): Promise<ServerMessage> {
  const msgPromise = nextMessage(socket);
  sendWs(socket, { type: "join", docId, replicaId, sinceSeq });
  return msgPromise;
}

export function waitForClose(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

export function uniqueEmail(): string {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@ysync-test.local`;
}
