import path from "node:path";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// repo-root ka .env load karta hai taaki local (Docker ke bahar) `prisma migrate`/`prisma generate` chalane pe DATABASE_URL mil jaaye
config({ path: path.resolve(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
