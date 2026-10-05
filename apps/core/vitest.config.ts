import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  /** Same `@/*` alias as tsconfig, so tests can import route modules. */
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    /** A valid environment for `src/lib/config.ts`, which every route module loads. */
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      SECRETS_ENCRYPTION_KEYS: Buffer.alloc(32, 1).toString("base64"),
      MAJORDOMO_API_TOKEN: "owner-token-0123456789abcdef0123456789",
      CRON_SECRET: "cron-secret-0123456789",
    },
    unstubEnvs: true,
  },
});
