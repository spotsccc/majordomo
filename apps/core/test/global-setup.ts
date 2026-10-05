/**
 * Vitest global setup: a fresh, migrated Postgres database for every test run.
 *
 * Starts the Postgres container from `compose.yaml` (as `pnpm db:up` does),
 * drops and recreates the database named in the `DATABASE_URL` of the test
 * environment (`vitest.config.ts`), then applies the `packages/db` migrations
 * with the same `migrate.ts` that production runs. The address is the compose
 * default, never `apps/core/.env.local`, so tests cannot touch another database.
 *
 * Throws when Docker is unavailable: Vitest aborts the run on a failed global
 * setup, and the message tells what to start.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export default function setup(project: TestProject): void {
  const url = project.config.env.DATABASE_URL;
  if (!url) throw new Error("vitest.config.ts не задаёт DATABASE_URL");
  const database = new URL(url).pathname.slice(1);

  run(
    "docker",
    ["compose", "up", "-d", "--wait"],
    "Тестам @repo/core нужен Postgres из Docker: запустите Docker и повторите.",
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

/** Runs a command from the repository root; throws with `failure` so Vitest aborts the run. */
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
