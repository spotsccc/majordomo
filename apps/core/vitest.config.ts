import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/** A misnamed test would silently not run, so the config refuses to load instead. */
const misnamed = globSync(
  ["src/**/*.{test,spec}.{ts,tsx}", "e2e/**/*.{test,spec}.{ts,tsx}"],
  { cwd: fileURLToPath(new URL(".", import.meta.url)) },
).filter((file) =>
  file.startsWith("e2e/")
    ? !/\.e2e\.test\.ts$/.test(file)
    : !/\.(unit|module|api)\.test\.ts$|\.component\.test\.tsx$/.test(file),
);
if (misnamed.length > 0) {
  throw new Error(
    `Имя теста не говорит его вид (src: <file>.<unit|module|api>.test.ts, <file>.component.test.tsx; e2e: <scenario>.e2e.test.ts): ${misnamed.join(", ")}`,
  );
}

export default defineConfig({
  /** Same `@/*` alias as tsconfig, so tests can import route modules. */
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    unstubEnvs: true,
    unstubGlobals: true,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.{unit,module,api}.test.ts"],
          globalSetup: "./vitest.global-setup.ts",
          /** Test files share one database, so they run one after another. */
          fileParallelism: false,
          env: {
            DATABASE_URL:
              "postgresql://majordomo:majordomo@127.0.0.1:5432/majordomo_test",
            SECRETS_ENCRYPTION_KEYS: Buffer.alloc(32, 1).toString("base64"),
            MAJORDOMO_API_TOKEN: "owner-token-0123456789abcdef0123456789",
            CRON_SECRET: "cron-secret-0123456789",
            TELEGRAM_BOT_TOKEN: "123456:test-bot-token",
            TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
            TELEGRAM_OWNER_ID: "100500",
            TELEGRAM_BOT_USERNAME: "majordomo_test_bot",
            XAI_API_KEY: "xai-test-key",
            COINGECKO_API_KEY: "cg-test-key",
          },
        },
      },
      {
        extends: true,
        /** tsconfig keeps JSX as is for Next.js; the browser needs it compiled. */
        oxc: { jsx: { runtime: "automatic" } },
        /** Next's compiler inlines the `process.env.__NEXT_*` reads of its client modules such as `next/link`; Vite replaces only `NODE_ENV`, and the browser has no `process`. */
        define: { "process.env": "{}" },
        test: {
          name: "component",
          include: ["src/**/*.component.test.tsx"],
          browser: {
            enabled: true,
            headless: true,
            /** A fixed locale and time zone, so dates render the same on every machine. */
            provider: playwright({
              contextOptions: { locale: "ru-RU", timezoneId: "UTC" },
            }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
