import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

// Prisma 7 mein explicit driver adapter dena hi padta hai — ab default Rust
// query engine nahi hota. Yeh wiring sirf yahi ek jagah hoti hai, isliye har
// consumer (apps/server, tests) ko bas connection string pass karni hoti hai.
export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl });
  return new PrismaClient({ adapter });
}
