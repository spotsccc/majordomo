import { createDatabase, type Database } from "@repo/db";
import { attachDatabasePool } from "@vercel/functions";
import { requiredEnv } from "./env";

let _db: Database | undefined;

/** One pool per function instance, reused across requests. */
export function getDb(): Database {
  if (_db) return _db;
  const { db, pool } = createDatabase(requiredEnv("DATABASE_URL"));
  // Lets Vercel close idle connections before a function instance is frozen.
  attachDatabasePool(pool);
  _db = db;
  return _db;
}
