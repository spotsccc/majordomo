import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.ts";

export type Database = ReturnType<typeof createDatabase>["db"];

/**
 * Connection for application code. On Vercel pass the pooled `DATABASE_URL`
 * and register the pool with `attachDatabasePool` from `@vercel/functions`.
 * Migrations and DBOS use the direct `DATABASE_URL_UNPOOLED` instead.
 */
export function createDatabase(
  connectionString: string,
  options: pg.PoolConfig = {},
) {
  const pool = new pg.Pool({ connectionString, max: 5, ...options });
  return { db: drizzle({ client: pool, schema }), pool };
}
