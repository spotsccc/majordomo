/**
 * Playwright starts the web server first; recreating the database here is safe because the
 * server connects only on the first request.
 */
import { recreateTestDatabase } from "../test-database.test-utils";
import { E2E_ENV } from "./env";

export default function globalSetup(): void {
  recreateTestDatabase(E2E_ENV.DATABASE_URL);
}
