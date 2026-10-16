/**
 * Variables already set in the environment win over the env file. drizzle-kit must never touch
 * `dbos` (DBOS) or `drizzle` (the migration journal), so `schemaFilter` lists only this
 * package's schemas.
 */
import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

const LOCAL_ENV = "../../apps/core/.env.local";
if (existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  schemaFilter: ["auth", "chat", "finance", "memory"],
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
});
