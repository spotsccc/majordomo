import { tryFn } from "@spotsccc/error-as-value";
import { z } from "zod";
import { SecretBox } from "./secret-box";

/** An empty value counts as not set, so `.env.example` and `E2E_ENV` can list it empty. */
const OptionalString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SECRETS_ENCRYPTION_KEYS: z
    .string()
    .min(1)
    .transform((value, ctx) => {
      const box = SecretBox.fromKeys(value.split(",").map((key) => key.trim()));
      if (box instanceof Error) {
        ctx.addIssue({ code: "custom", message: box.message });
        return z.NEVER;
      }
      return box;
    }),
  MAJORDOMO_API_TOKEN: z.string().min(32),
  CRON_SECRET: z.string().min(1),
  OPENAI_MODEL: z
    .string()
    .optional()
    .transform((value) => value || "gpt-6-sol"),
  TELEGRAM_BOT_TOKEN: OptionalString,
  TELEGRAM_WEBHOOK_SECRET: OptionalString,
  /** Checked strictly: the adapter drops a blank id and then answers everyone. */
  TELEGRAM_OWNER_ID: z
    .union([
      z.literal(""),
      z.string().regex(/^[1-9]\d*$/, "числовой id пользователя Telegram"),
    ])
    .optional()
    .transform((value) => value || undefined),
  TELEGRAM_BOT_USERNAME: OptionalString,
  XAI_API_KEY: OptionalString,
  COINGECKO_API_KEY: OptionalString,
  OWNER_TIME_ZONE: z
    .string()
    .optional()
    .transform((value) => value || "UTC")
    .refine(
      (zone) =>
        !(
          tryFn(
            () => new Intl.DateTimeFormat("en", { timeZone: zone }),
          ) instanceof Error
        ),
      "часовой пояс IANA, например America/Argentina/Buenos_Aires",
    ),
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    `Переменные окружения заданы неверно:\n${z.prettifyError(parsed.error)}`,
  );
}

/**
 * Throws on load: a missing or invalid variable stops `next build` or the server start with
 * every problem listed, and there is no caller to return an error to.
 */
export const config = parsed.data;
