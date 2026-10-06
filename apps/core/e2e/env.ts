/**
 * Addresses and environment of the e2e run. Shared by `playwright.config.ts`
 * (the server and the test processes) and `fixtures.ts` (the fake OpenAI).
 */

/** Where the e2e Next.js server listens; not 3000, so `pnpm dev` can keep running. */
export const BASE_URL = "http://127.0.0.1:3100";

/**
 * Where the fake OpenAI of the Playwright worker listens (`fixtures.ts`). The
 * server reaches it through `fake-openai.ts`.
 */
export const FAKE_OPENAI_URL = "http://127.0.0.1:4010";

/**
 * The environment of the e2e server and of the test processes, which load app
 * modules (`@/lib/db`) to seed and check the database. The database is
 * `majordomo_e2e` on the `compose.yaml` server, recreated by
 * `global-setup.ts`; the values never come from `.env.local`.
 */
export const E2E_ENV = {
  DATABASE_URL: "postgresql://majordomo:majordomo@127.0.0.1:5432/majordomo_e2e",
  SECRETS_ENCRYPTION_KEYS: Buffer.alloc(32, 2).toString("base64"),
  MAJORDOMO_API_TOKEN: "e2e-owner-token-0123456789abcdef0123",
  CRON_SECRET: "e2e-cron-secret-0123456789",
  OPENAI_MODEL: "gpt-e2e",
};
