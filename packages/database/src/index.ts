// re-exports the public bits of the generated Prisma client so consumers never import directly from ../generated
export { createPrismaClient } from "./client.js";
export { PrismaClient, Prisma, DocumentRole } from "../generated/prisma/client.js";
export type { Document, Operation, Snapshot, User, Session, Account, Verification, DocumentMember } from "../generated/prisma/client.js";
