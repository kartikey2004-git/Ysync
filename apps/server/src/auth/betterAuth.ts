import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import type { PrismaClient } from "@ysync/database";

export function createAuth(prisma: PrismaClient) {
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);

  const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:8080";

  // When no explicit list is given, fall back to localhost:3000 (local dev default).
  // An empty trustedOrigins array causes Better Auth to reject all cross-origin requests.
  const trustedOrigins = allowedOrigins?.length
    ? allowedOrigins
    : ["http://localhost:3000"];

  return betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    secret: process.env.BETTER_AUTH_SECRET,
    baseURL,
    trustedOrigins,
    emailAndPassword: { enabled: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    advanced: {
      database: { joins: true },
      cookiePrefix: "ysync",
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
