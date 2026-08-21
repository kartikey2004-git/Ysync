// re-exports the public bits of the generated Prisma client so consumers never import directly from ../generated
export { createPrismaClient } from "./client.js";
export { PrismaClient, Prisma } from "../generated/prisma/client.js";
export type { Document, Operation, Snapshot } from "../generated/prisma/client.js";
