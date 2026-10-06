import { createDatabase } from "@repo/db";
import { attachDatabasePool } from "@vercel/functions";
import { config } from "./config";

const database = createDatabase(config.DATABASE_URL);
attachDatabasePool(database.pool);

/**
 * One pool per function instance, reused across requests. The pool connects
 * on the first query. `attachDatabasePool` lets Vercel close idle connections
 * before a function instance is frozen.
 */
export const db = database.db;

/**
 * The pool behind `db`, for a library that takes a `pg.Pool` rather than
 * Drizzle: the Chat SDK state adapter of the Telegram bot.
 */
export const pool = database.pool;
