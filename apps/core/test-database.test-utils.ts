import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * `url` must point at the compose container and name a `*_test` or `*_e2e` database, so a wrong
 * URL harms neither the development database nor another server. Throws, so the test runner
 * aborts.
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
