import path from "node:path";
import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";

// loads the repo-root .env so DATABASE_URL is available when running `prisma migrate`/`prisma generate` locally (outside Docker)
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
