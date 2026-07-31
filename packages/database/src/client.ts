import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

/**
 * Prisma 7 requires an explicit driver adapter — there's no default Rust
 * query engine anymore. This is the one place that wiring happens, so
 * every consumer (apps/server, tests) just passes a connection string.
 */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
