import { defineConfig } from "drizzle-kit";

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
