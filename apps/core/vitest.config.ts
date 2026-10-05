import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  /** Same `@/*` alias as tsconfig, so tests can import route modules. */
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    /** Recreates and migrates the test database in Docker before the run. */
    globalSetup: "./test/global-setup.ts",
    /** Test files share one database, so they run one after another. */
    fileParallelism: false,
    /** A valid environment for `src/lib/config.ts`, which every route module loads. */
    env: {
      /** The `compose.yaml` server; `test/global-setup.ts` recreates this database. */
      DATABASE_URL:
        "postgresql://majordomo:majordomo@127.0.0.1:5432/majordomo_test",
      SECRETS_ENCRYPTION_KEYS: Buffer.alloc(32, 1).toString("base64"),
      MAJORDOMO_API_TOKEN: "owner-token-0123456789abcdef0123456789",
      CRON_SECRET: "cron-secret-0123456789",
    },
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
