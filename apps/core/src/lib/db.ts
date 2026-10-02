import { createDatabase, type Database } from "@repo/db";
import { attachDatabasePool } from "@vercel/functions";
import { requiredEnv, type ConfigurationError } from "./env";

let _db: Database | undefined;

/** One pool per function instance, reused across requests. */
export function getDb(): ConfigurationError | Database {
  if (_db) return _db;
  const url = requiredEnv("DATABASE_URL");
  if (url instanceof Error) return url;

  const { db, pool } = createDatabase(url);
  // Lets Vercel close idle connections before a function instance is frozen.
  attachDatabasePool(pool);
  _db = db;
  return _db;
}
