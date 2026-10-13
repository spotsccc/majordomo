/**
 * - Uses the direct connection: PgBouncer in transaction mode breaks the session-level lock and
 *   multi-statement migrations.
 * - Holds an advisory lock: the Drizzle migrator has none, and two deployments may build at
 *   once.
 * - On Vercel migrates only production, and previews only when enabled, so a misconfigured
 *   preview never alters the production schema.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { tryAsync } from "@spotsccc/error-as-value";
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

function connectionString(env: NodeJS.ProcessEnv): Error | string {
  const url = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
  if (!url)
    return new Error("Не задан DATABASE_URL_UNPOOLED (или DATABASE_URL)");
  if (new URL(url).hostname.includes("-pooler")) {
    return new Error(
      "Для миграций нужен прямой адрес Neon (DATABASE_URL_UNPOOLED), а не пул соединений",
    );
  }
  return url;
}

async function main(): Promise<Error | undefined> {
  const reason = skipReason(process.env);
  if (reason) {
    console.log(`Миграции пропущены. ${reason}`);
    return undefined;
  }
  const url = connectionString(process.env);
  if (url instanceof Error) return url;

  const client = new pg.Client({ connectionString: url });
  const connected = await tryAsync(
    () => client.connect(),
    (error) => error,
  );
  if (connected instanceof Error) return connected;

  const migrated = await tryAsync(
    async () => {
      await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
      await migrate(drizzle({ client }), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: "drizzle",
        migrationsTable: "__drizzle_migrations",
      });
    },
    (error) => error,
  );
  await client
    .query("select pg_advisory_unlock($1)", [LOCK_KEY])
    .catch(() => {});
  await client.end();
  if (migrated instanceof Error) return migrated;

  console.log("Миграции применены.");
  return undefined;
}

const error = await tryAsync(main, (error) => error);
if (error) {
  console.error(error);
  process.exitCode = 1;
}
