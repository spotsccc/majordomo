import { createDatabase } from "@repo/db";
import { attachDatabasePool } from "@vercel/functions";
import { config } from "./config";

const database = createDatabase(config.DATABASE_URL);
attachDatabasePool(database.pool);

/** `attachDatabasePool` lets Vercel close idle connections before a function instance is frozen. */
export const db = database.db;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const pool = database.pool;
