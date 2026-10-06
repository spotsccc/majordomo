/**
 * Vitest global setup of the `node` project: a fresh, migrated
 * `majordomo_test` database for every test run
 * (`test-database.test-utils.ts`). The address is the compose default from
 * the `DATABASE_URL` of the test environment (`vitest.config.ts`), never
 * `apps/core/.env.local`, so tests cannot touch another database.
 */
import type { TestProject } from "vitest/node";
import { recreateTestDatabase } from "./test-database.test-utils";

export default function setup(project: TestProject): void {
  const url = project.config.env.DATABASE_URL;
  if (!url) throw new Error("vitest.config.ts не задаёт DATABASE_URL");
  recreateTestDatabase(url);
}
