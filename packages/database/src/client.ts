import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

// Prisma 7 requires an explicit driver adapter — there's no default Rust query engine anymore. This wiring lives in exactly one place, so every consumer (apps/server, tests) just has to pass a connection string.
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
