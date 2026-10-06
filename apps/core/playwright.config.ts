import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, E2E_ENV, FAKE_OPENAI_URL } from "./e2e/env";

/**
 * Test processes load app modules (`@/lib/config`, `@/lib/db`) to seed and
 * check the database, so they get the server's environment. Playwright loads
 * this file in the runner and in every worker before the tests.
 */
Object.assign(process.env, E2E_ENV);

/** End-to-end tests: user scenarios in Chromium against the production build and the `majordomo_e2e` database. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.test.ts",
  globalSetup: "./e2e/global-setup.ts",
  /** One owner, one ChatGPT session and one fake OpenAI port: tests run one at a time. */
  workers: 1,
  reporter: "list",
  use: {
    baseURL: BASE_URL,
    locale: "ru-RU",
    timezoneId: "UTC",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    /**
     * The production build, served with OpenAI replaced by the fake: the
     * preload (`e2e/fake-openai.ts`) loads into `next start` only, not into
     * the build and its workers.
     */
    command: `next build && NODE_OPTIONS=--import=${new URL("./e2e/fake-openai.ts", import.meta.url).href} next start --hostname 127.0.0.1 --port ${new URL(BASE_URL).port}`,
    url: `${BASE_URL}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      ...E2E_ENV,
      E2E_OPENAI_URL: FAKE_OPENAI_URL,
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
