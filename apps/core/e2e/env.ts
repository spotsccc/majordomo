/** Not 3000, so `pnpm dev` can keep running. */
export const BASE_URL = "http://127.0.0.1:3100";

export const FAKE_OPENAI_URL = "http://127.0.0.1:4010";

export const E2E_ENV = {
  DATABASE_URL: "postgresql://majordomo:majordomo@127.0.0.1:5432/majordomo_e2e",
  SECRETS_ENCRYPTION_KEYS: Buffer.alloc(32, 2).toString("base64"),
  MAJORDOMO_API_TOKEN: "e2e-owner-token-0123456789abcdef0123",
  CRON_SECRET: "e2e-cron-secret-0123456789",
  OPENAI_MODEL: "gpt-e2e",
  TELEGRAM_BOT_TOKEN: "",
  TELEGRAM_WEBHOOK_SECRET: "",
  TELEGRAM_OWNER_ID: "",
  TELEGRAM_BOT_USERNAME: "",
  XAI_API_KEY: "",
  OWNER_TIME_ZONE: "",
  COINGECKO_API_KEY: "",
};
