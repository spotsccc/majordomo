import { z } from "zod";
import { SecretBox } from "./secret-box";

/**
 * A variable that only some environments set. An empty value counts as not
 * set, so `.env.example` and `E2E_ENV` can list it empty.
 */
const OptionalString = z
  .string()
  .optional()
  .transform((value) => value || undefined);

const ConfigSchema = z.object({
  /** Pooled Postgres URL for application code. */
  DATABASE_URL: z.string().min(1),
  /**
   * Comma-separated base64 keys, already turned into a `SecretBox`: the first
   * key encrypts, all of them decrypt.
   */
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
  /** Owner's API token: `Authorization: Bearer $MAJORDOMO_API_TOKEN`. */
  MAJORDOMO_API_TOKEN: z.string().min(32),
  /** Vercel Cron sends it as `Authorization: Bearer $CRON_SECRET`. */
  CRON_SECRET: z.string().min(1),
  /** Agent model; an empty value means the default, as when it is not set. */
  OPENAI_MODEL: z
    .string()
    .optional()
    .transform((value) => value || "gpt-5.6-luna"),
  /**
   * Token of the Telegram bot from @BotFather. Production sets the Telegram
   * variables, a developer sets their own dev bot locally; without the token,
   * the secret and the owner id the bot is off (`@/lib/telegram/bot`).
   */
  TELEGRAM_BOT_TOKEN: OptionalString,
  /** Telegram sends it as `X-Telegram-Bot-Api-Secret-Token` with every webhook. */
  TELEGRAM_WEBHOOK_SECRET: OptionalString,
  /**
   * Telegram user id of the owner, the only user the bot answers. Checked
   * strictly: the adapter drops a blank id and then answers everyone.
   */
  TELEGRAM_OWNER_ID: z
    .union([
      z.literal(""),
      z.string().regex(/^[1-9]\d*$/, "числовой id пользователя Telegram"),
    ])
    .optional()
    .transform((value) => value || undefined),
  /** The bot's username; without it the adapter asks Telegram (`getMe`) on start. */
  TELEGRAM_BOT_USERNAME: OptionalString,
  /**
   * xAI key for transcribing the owner's Telegram voice messages. Without it
   * the bot answers a voice message that transcription is not set up and
   * handles everything else.
   */
  XAI_API_KEY: OptionalString,
});

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    `Переменные окружения заданы неверно:\n${z.prettifyError(parsed.error)}`,
  );
}

/**
 * Server configuration, parsed from the environment once when the module
 * loads. `instrumentation.ts` imports this module when the server starts, and
 * `next build` loads it with the route modules, so a missing or invalid
 * variable stops the build or the server with a list of every problem instead
 * of failing the request that needs it. Code that runs after startup reads
 * values from here without checks.
 *
 * The module throws on load: aborting startup is the point, and there is no
 * caller to return an error to.
 */
export const config = parsed.data;
