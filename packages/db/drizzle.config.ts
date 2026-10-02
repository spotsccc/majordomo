import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Locally the database URL lives in the app's env file (see compose.yaml); the path
// is relative to packages/db, where pnpm runs drizzle-kit.
// Variables already set in the environment win over the file.
const LOCAL_ENV = "../../apps/core/.env.local";
if (existsSync(LOCAL_ENV)) process.loadEnvFile(LOCAL_ENV);

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Only schemas owned by this package. `dbos` belongs to DBOS and `drizzle`
  // holds the migration journal; drizzle-kit must never touch them.
  schemaFilter: ["auth"],
  migrations: { schema: "drizzle", table: "__drizzle_migrations" },
  dbCredentials: {
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "",
  },
});
