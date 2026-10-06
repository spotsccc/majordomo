/**
 * Every domain lives in its own Postgres schema (auth, chat, finance, ...),
 * never in `public`. Add a new file per domain and list its schema in
 * `schemaFilter` in drizzle.config.ts. See docs/architecture/database.md.
 */
export * from "./auth.ts";
export * from "./chat.ts";
