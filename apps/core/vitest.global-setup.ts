/**
 * The address comes from the test environment, never `.env.local`, so tests cannot touch
 * another database.
 */
import type { TestProject } from "vitest/node";
import { recreateTestDatabase } from "./test-database.test-utils";

export default function setup(project: TestProject): void {
  const url = project.config.env.DATABASE_URL;
  if (!url) throw new Error("vitest.config.ts не задаёт DATABASE_URL");
  recreateTestDatabase(url);
}
