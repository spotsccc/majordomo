/**
 * Applies database migrations. Run by the Vercel build (see apps/core/vercel.json)
 * and by hand for local databases: `pnpm --filter @repo/db migrate`.
 *
 * - Uses the direct connection (DATABASE_URL_UNPOOLED): PgBouncer in transaction
 *   mode breaks the session-level lock below and multi-statement migrations.
 * - Holds an advisory lock, so two deployments building at once run one after
 *   the other (the Drizzle migrator itself has no lock).
 * - On Vercel migrates only production, and previews only when explicitly
 *   enabled, so a misconfigured preview can never alter the production schema.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const LOCK_KEY = 4_815_162_342;
const MIGRATIONS_FOLDER = new URL("../migrations", import.meta.url).pathname;

function skipReason(env: NodeJS.ProcessEnv): string | null {
  if (!env.VERCEL) return null;
  if (env.VERCEL_ENV === "production") return null;
  if (
    env.VERCEL_ENV === "preview" &&
    env.MIGRATE_PREVIEW_DATABASES === "true"
  ) {
    return null;
  }
  return `VERCEL_ENV=${env.VERCEL_ENV}: миграции выполняются только для production и, если включено MIGRATE_PREVIEW_DATABASES, для preview-веток Neon`;
}

function connectionString(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  if (!url)
    throw new Error("Не задан DATABASE_URL_UNPOOLED (или DATABASE_URL)");
  if (new URL(url).hostname.includes("-pooler")) {
    throw new Error(
      "Для миграций нужен прямой адрес Neon (DATABASE_URL_UNPOOLED), а не пул соединений",
    );
  }
  return url;
}

async function main(): Promise<void> {
  const reason = skipReason(process.env);
  if (reason) {
    console.log(`Миграции пропущены. ${reason}`);
    return;
  }
  const client = new pg.Client({
    connectionString: connectionString(process.env),
  });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await migrate(drizzle({ client }), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsSchema: "drizzle",
      migrationsTable: "__drizzle_migrations",
    });
    // When DBOS is added: migrate its system schema here with
    // `DBOS.migrate(url, { schemaName: "dbos" })` and launch DBOS with
    // `runMigrations: false`, so function instances never run DDL.
    console.log("Миграции применены.");
  } finally {
    await client
      .query("select pg_advisory_unlock($1)", [LOCK_KEY])
      .catch(() => {});
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
