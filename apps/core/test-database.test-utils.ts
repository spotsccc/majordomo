/**
 * A fresh, migrated test database on the `compose.yaml` Postgres. Shared by
 * the Vitest global setup (`majordomo_test`) and the Playwright global setup
 * (`majordomo_e2e`).
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Starts the Postgres container from `compose.yaml` (as `pnpm db:up` does),
 * drops and recreates the database named in `url`, then applies the
 * `packages/db` migrations with the same `migrate.ts` that production runs.
 * DROP and CREATE run inside the compose container while the migrations
 * connect to `url`, so `url` must point at that container
 * (`127.0.0.1:5432` or `localhost:5432`) and name a test database
 * (`*_test` or `*_e2e`); a wrong URL can then harm neither the development
 * database nor another server.
 *
 * Throws when `url` is not such a test database, when Docker is unavailable
 * or a step fails: both test runners abort on a failed global setup, and the
 * message says what to start.
 */
export function recreateTestDatabase(url: string): void {
  const { hostname, port, pathname } = new URL(url);
  const database = pathname.slice(1);
  if (
    !["127.0.0.1", "localhost"].includes(hostname) ||
    port !== "5432" ||
    !/_(test|e2e)$/.test(database)
  ) {
    throw new Error(
      `${url} — не тестовая база compose.yaml (127.0.0.1:5432, *_test или *_e2e), не пересоздаю.`,
    );
  }

  run(
    "docker",
    ["compose", "up", "-d", "--wait"],
    "Тестам нужен Postgres из Docker: запустите Docker и повторите.",
  );
  for (const sql of [
    `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
    `CREATE DATABASE "${database}"`,
  ]) {
    run(
      "docker",
      [
        "compose",
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "majordomo",
        "-d",
        "majordomo",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
      ],
      `Не удалось пересоздать тестовую базу ${database}.`,
    );
  }
  run(
    "node",
    ["packages/db/src/migrate.ts"],
    `Не удалось применить миграции к тестовой базе ${database}.`,
    { DATABASE_URL_UNPOOLED: url },
  );
}

/** Runs a command from the repository root; throws with `failure` so the test runner aborts. */
function run(
  command: string,
  args: string[],
  failure: string,
  env: Record<string, string> = {},
): void {
  try {
    execFileSync(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch (cause) {
    throw new Error(failure, { cause });
  }
}
