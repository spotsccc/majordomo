import { z } from "zod";
import { SecretBox } from "./secret-box";

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
