/**
 * Playwright global setup: a fresh, migrated `majordomo_e2e` database for
 * every run (`test-database.test-utils.ts`). Playwright starts the web server
 * first; the server connects to the database only on the first request, so
 * recreating it here is safe. Tests seed what they need themselves.
 */
import { recreateTestDatabase } from "../test-database.test-utils";
import { E2E_ENV } from "./env";

export default function globalSetup(): void {
  recreateTestDatabase(E2E_ENV.DATABASE_URL);
}
